import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — every `materializeCompositeGraph` call site wires the Rule Loop
 * callers, so materialization cannot fork on governance state.
 *
 * MEASURED SEVERANCE. `materializeCompositeGraph` answered a missing
 * `skillCaller` / `automationCaller` / `ruleCaller` with `logger.warn` +
 * `continue` — a SILENT SKIP that still reported success. Only ONE of its five
 * production call sites wired them (`routers/proposals/apply-approval.ts`); the
 * other four (`routers/capture.ts`,
 * `services/capture-agent/submit-capture-graph.ts`, and BOTH
 * `services/import-orchestrator.ts` paths) wired none.
 *
 * So once a producer emits a `create_skill` / `create_automation` /
 * `create_rule` op, the SAME batch would materialize its config ops when the
 * write happened to be GOVERNED (approval) and silently drop them when it was
 * AUTO-APPROVED (direct write). A governance system whose OUTPUT depends on the
 * governance verdict is the one thing it must never be.
 *
 * Two guards, both needed:
 *   - runtime: a FAIL-CLOSED preflight in `materializeCompositeGraph` refuses a
 *     batch whose config op has no caller, BEFORE anything is written;
 *   - source: this scan, so a new call site does not ship half-wired and only
 *     discover it when a real producer appears.
 *
 * ── WHAT THIS SCAN HARDENED AGAINST (three measured escapes) ───────────────
 *  1. FILE-LEVEL PRESENCE. The check was `!src.includes("buildRuleLoopCallers")`
 *     — one import line, one comment, or one wired call site satisfied a WHOLE
 *     FILE. `services/import-orchestrator.ts` has TWO call sites (`apply` and
 *     `applyLarge`): wiring one and leaving the other bare stayed GREEN. The
 *     scan now slices PER CALL SITE (balanced parens) and requires the factory
 *     to be SPREAD into that call's own argument list.
 *  2. COMMENT-SATISFIABLE RUNTIME CHECK. `toContain("wired no matching caller")`
 *     matched the prose in the preflight's own comment block — deleting the
 *     `throw` left it green. COMMENTS are stripped before any scan, and the preflight is asserted STRUCTURALLY: the missing-caller
 *     predicate exists inside the materializer's body, throws, and does so
 *     BEFORE any caller write.
 *  3. WORDING-PINNED NEGATIVE. `not.toMatch(/no (skill|automation|rule)Caller
 *     wired by this caller/)` pinned the OLD warn sentence; any rewording
 *     defeated it. Replaced with the structural claim: the missing-caller path
 *     must not `continue` past the op.
 */

const API_SRC = join(__dirname, "..");
const MATERIALIZER = join(API_SRC, "utils", "materialize-composite.ts");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.includes(".test.ts") || full.includes("__tests__")) continue;
    // The materializer itself, and the factory it documents.
    if (name === "materialize-composite.ts") continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank out COMMENTS, preserving offsets. String bodies are kept — the
 * preflight's own predicate compares against `"create_skill"` literals — but
 * the scanner still walks over strings so a `//` inside one cannot be mistaken
 * for a comment. Without this a COMMENT satisfies every `includes()` in this
 * file, which is exactly how the old runtime-preflight assertion could be
 * satisfied by prose.
 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        j++;
      }
      // String body kept verbatim; we only skip past it.
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Every `<marker>(` call in `src`, as [offset, balanced-paren text]. */
function callSites(src: string, marker: string): [number, string][] {
  const found: [number, string][] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    found.push([at, src.slice(at, i + 1)]);
    from = i + 1;
  }
  return found;
}

/** Balanced-brace body of the function declared at `declAt`. */
function functionBody(src: string, declAt: number): string {
  // First `{` that opens the BODY: skip the parameter list.
  let i = declAt;
  let paren = 0;
  let seenParams = false;
  for (; i < src.length; i++) {
    if (src[i] === "(") {
      paren++;
      seenParams = true;
    } else if (src[i] === ")") {
      paren--;
    } else if (src[i] === "{" && seenParams && paren === 0) break;
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return src.slice(i);
}

/** Balanced-brace text starting at the `{` at `start`. */
function balancedBlock(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

const MATERIALIZE = "materializeCompositeGraph(";
/** Whitespace-tolerant: `... buildRuleLoopCallers (` is the same wiring. */
const WIRED = /\.\.\.\s*buildRuleLoopCallers\s*\(/;

describe("TRIPWIRE: Rule Loop callers wired at every materialize call site", () => {
  const files = collectSourceFiles(API_SRC);
  const stripped = new Map(
    files.map((f) => [f, stripComments(readFileSync(f, "utf8"))])
  );
  // PER CALL SITE, not per file: import-orchestrator.ts alone holds two.
  const sites = files.flatMap((f) =>
    callSites(stripped.get(f)!, MATERIALIZE).map(
      ([, text]) => [f.slice(API_SRC.length + 1), text] as const
    )
  );

  it("finds the call sites it is supposed to police", () => {
    const callerFiles = new Set(sites.map(([rel]) => rel));
    // Four production FILES / five CALL SITES at the time of writing
    // (import-orchestrator.ts contributes two). A scan that matches nothing
    // proves nothing.
    expect(callerFiles.size).toBeGreaterThanOrEqual(4);
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it("every call site wires the callers through the ONE factory", () => {
    const unwired = sites
      .filter(([, text]) => !WIRED.test(text))
      .map(([rel]) => rel);
    expect(
      unwired,
      "Each `materializeCompositeGraph(...)` CALL — not merely each file — must " +
        "spread `buildRuleLoopCallers({...})` (utils/rule-loop-callers.ts) into its " +
        "own options argument. An unwired call site drops create_skill / " +
        "create_automation / create_rule ops, which is how materialization forks " +
        "on governance state. (A sibling call site in the same file wiring it is " +
        "NOT coverage: import-orchestrator.ts has two.)"
    ).toEqual([]);
  });

  it("the materializer REFUSES an unwired config op instead of skipping it", () => {
    const raw = readFileSync(MATERIALIZER, "utf8");
    const src = stripComments(raw);
    const declAt = src.indexOf(
      "export async function materializeCompositeGraph"
    );
    expect(
      declAt,
      "materializeCompositeGraph declaration not found"
    ).toBeGreaterThan(-1);
    const body = functionBody(src, declAt);

    // The predicate itself — all three config arms, whitespace-tolerant. Asserted
    // on COMMENT-STRIPPED source inside the function BODY, so neither the
    // preflight's own prose nor a dead helper can satisfy it.
    const arms = ["skill", "automation", "rule"] as const;
    for (const arm of arms) {
      const pattern = new RegExp(
        `op\\.op\\s*===\\s*["\x27\u0060]create_${arm}["\x27\u0060][\\s\\S]{0,80}?!\\s*options\\??\\.\\s*${arm}Caller`
      );
      expect(
        pattern.test(body),
        `the preflight must test create_${arm} against a missing ${arm}Caller`
      ).toBe(true);
    }

    // It must THROW, and throw BEFORE anything is written. `Caller.create(` is
    // the first thing a pass does; the refusal must precede all of them.
    const predicateAt = body.search(/const\s+missingConfigCaller\s*=/);
    expect(
      predicateAt,
      "the fail-closed preflight (missingConfigCaller) is gone from the body"
    ).toBeGreaterThan(-1);

    // The refusal must live INSIDE the `if (missingConfigCaller) { … }` block —
    // not merely somewhere downstream, which a later unrelated throw satisfies.
    const guardAt = body.search(/if\s*\(\s*missingConfigCaller\s*\)/);
    expect(
      guardAt,
      "the missing-caller predicate is computed but never acted on"
    ).toBeGreaterThan(-1);
    const guardBlock = balancedBlock(body, body.indexOf("{", guardAt));
    expect(
      /\bthrow\s+new\s+\w*Error\s*\(/.test(guardBlock),
      "the missing-caller branch must THROW — logging and continuing is exactly " +
        "the silent skip this tripwire exists to prevent. Branch was: " +
        guardBlock.slice(0, 200)
    ).toBe(true);
    expect(
      /\bcontinue\s*;/.test(guardBlock),
      "the missing-caller branch must not `continue` past the op"
    ).toBe(false);

    const firstWriteAt = body.search(/\w*[Cc]aller\??\.\s*create\s*\(/);
    expect(
      firstWriteAt,
      "no materializer write found — scan is blind"
    ).toBeGreaterThan(-1);
    expect(
      predicateAt,
      "the refusal must be a PREFLIGHT: it runs before any op is written, so an " +
        "unwirable batch materializes NOTHING rather than half of itself"
    ).toBeLessThan(firstWriteAt);
  });
});
