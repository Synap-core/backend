import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — session spawn (`links.spawned_from`) stays BEST-EFFORT.
 *
 * DECISION (founder, 2026-09-07): a `recordSessionSpawn` failure must NEVER
 * fail the session it is trying to link — the child session (or the run, or
 * the approved proposal) has to survive a bad parent handle, a transport
 * blip, or any other unexpected error from the lineage-edge write. Two of
 * the three producers already say this in their own comments:
 *   - `create-session.ts`: "a bad parent handle must not roll back a
 *     legitimate session"
 *   - `open-run-session.ts`: "this runs AFTER the session row is committed
 *     and inside the jobs layer, where a throw fails the whole run"
 * This is the opposite of the transactional guarantee `revertConversion`
 * (session-conversion.ts) now gets for its undo path — spawn is fire-and-
 * forget by contract, revert is all-or-nothing by contract. A future
 * "let's make this more robust" refactor that wraps spawn in a transaction
 * or lets it throw would silently reintroduce "session created, 500
 * returned" or "approval marked FAILED despite the row existing".
 *
 * This scans the THREE known producers and asserts every `recordSessionSpawn(`
 * call site is guarded: either inside a `try { … } catch { … }` whose handler
 * does not rethrow, or chained with `.catch(...)` whose handler does not
 * rethrow. If this goes red because a NEW call site is unguarded, wrap it —
 * do not delete or weaken this test.
 */

const PRODUCERS = [
  join(process.cwd(), "src/services/focus-sessions/create-session.ts"),
  join(process.cwd(), "../database/src/utils/open-run-session.ts"),
  join(process.cwd(), "src/routers/proposals/executors/focus-session.ts"),
];

const CALL = "recordSessionSpawn(";

/**
 * Strip `//` and `/* … *​/` comments so brace-counting can't be fooled by
 * prose (these files' own header comments talk about "try/catch" and
 * "throw"). Applied to a LOCAL WINDOW around the call site, not the whole
 * file — a file-wide strip is one stray `/*`/`*​/` or `//` inside an unrelated
 * string literal away from silently eating the call itself.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Index of the `{` that opens the innermost block directly enclosing `at`. */
function enclosingBraceOpen(src: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Index of the `}` matching the `{` at `openIdx`. */
function matchingBraceClose(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the `)` matching the `(` at `openIdx`. */
function matchingParenClose(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface CallCheck {
  guarded: boolean;
  rethrows: boolean;
  detail: string;
}

/**
 * Is the `recordSessionSpawn(` call at `callIdx` inside `try { } catch { }`
 * (handler not rethrowing), or immediately `.catch(handler)`-chained (handler
 * not rethrowing)? Either shape satisfies "best-effort".
 */
function checkCallSite(src: string, callIdx: number): CallCheck {
  // Shape A: try { ... recordSessionSpawn(...) ... } catch (e) { ...no throw... }
  const tryOpen = enclosingBraceOpen(src, callIdx);
  if (tryOpen >= 0) {
    const before = src.slice(0, tryOpen).trimEnd();
    if (/\btry\s*$/.test(before)) {
      const tryClose = matchingBraceClose(src, tryOpen);
      const afterTry = src.slice(tryClose + 1).trimStart();
      if (/^catch\b/.test(afterTry)) {
        const catchBraceOpen = src.indexOf("{", tryClose + 1);
        const catchBraceClose = matchingBraceClose(src, catchBraceOpen);
        const catchBody = src.slice(catchBraceOpen + 1, catchBraceClose);
        return {
          guarded: true,
          rethrows: /\bthrow\b/.test(catchBody),
          detail: "try/catch",
        };
      }
    }
  }

  // Shape B: recordSessionSpawn(...).catch((err) => { ...no throw... })
  const parenOpen = src.indexOf("(", callIdx + CALL.length - 1);
  const parenClose = matchingParenClose(src, parenOpen);
  const afterCall = src.slice(parenClose + 1).trimStart();
  if (afterCall.startsWith(".catch(")) {
    const catchParenOpen = parenClose + 1 + afterCall.indexOf("(");
    const catchParenClose = matchingParenClose(src, catchParenOpen);
    const catchBody = src.slice(catchParenOpen + 1, catchParenClose);
    return {
      guarded: true,
      rethrows: /\bthrow\b/.test(catchBody),
      detail: ".catch(...)",
    };
  }

  return { guarded: false, rethrows: false, detail: "unguarded" };
}

describe("tripwire: session spawn (recordSessionSpawn) stays best-effort", () => {
  it("every known call site is try/catch or .catch()-guarded, and the handler never rethrows", () => {
    const findings: string[] = [];

    const WINDOW = 1500;

    for (const path of PRODUCERS) {
      const raw = readFileSync(path, "utf8");
      const rawCallIdx = raw.indexOf(CALL);
      if (rawCallIdx === -1) {
        findings.push(
          `${path}: no \`recordSessionSpawn(\` call found — producer moved or removed; update PRODUCERS`
        );
        continue;
      }
      // Only one call site is expected per file today.
      const rawSecond = raw.indexOf(CALL, rawCallIdx + 1);
      if (rawSecond !== -1) {
        findings.push(
          `${path}: found MORE THAN ONE recordSessionSpawn( call — this tripwire only checks the first; extend it`
        );
      }

      // Comment-strip only a LOCAL WINDOW around the call — a file-wide strip
      // risks eating the call itself if an unrelated string elsewhere in the
      // file contains an unbalanced `/*`/`//`.
      const winStart = Math.max(0, rawCallIdx - WINDOW);
      const winEnd = Math.min(raw.length, rawCallIdx + WINDOW);
      const src = stripComments(raw.slice(winStart, winEnd));
      const callIdx = src.indexOf(CALL);
      if (callIdx === -1) {
        findings.push(
          `${path}: recordSessionSpawn( call vanished after comment-stripping its surrounding window — widen WINDOW or inspect manually`
        );
        continue;
      }

      const check = checkCallSite(src, callIdx);
      if (!check.guarded) {
        findings.push(
          `${path}: recordSessionSpawn( call is NOT guarded by try/catch or .catch() — ` +
            `a lineage-edge failure here would fail the whole session/run/approval, ` +
            `violating the best-effort decision`
        );
      } else if (check.rethrows) {
        findings.push(
          `${path}: recordSessionSpawn( is guarded (${check.detail}) but its handler ` +
            `RETHROWS — that defeats best-effort just as much as no guard at all`
        );
      }
    }

    expect(findings).toEqual([]);
  });
});
