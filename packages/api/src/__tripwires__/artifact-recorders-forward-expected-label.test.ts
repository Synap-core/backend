import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE — every `recordSessionArtifact(` call site forwards `expectedLabel`.
 *
 * `recordSessionArtifact` (`services/focus-sessions/record-session-artifact.ts`)
 * is the ONE producer door for "this session made that". Its `expectedLabel`
 * param is the DECLARED slot claim — written into `artifacts.props.expectedLabel`
 * and read back by `session-outputs.ts`'s join so a produced object lands on the
 * declared deliverable a human or agent actually MEANT, not the first output of
 * the same kind. A call site that omits the key can never claim a slot: before
 * the Output-Loop W5 wave only the two human-facing doors (tRPC
 * `focusSessions.attachOutput`, Hub REST `POST /focus-sessions/:id/outputs`)
 * passed it — every agent create door (`documents.createDocument`,
 * `synap_store_file`, `entities.create`, `views.createView`) recorded a
 * ledger row that could never resolve to a declared slot.
 *
 * This does not prove the VALUE threaded to `expectedLabel` is correct, or even
 * defined at runtime (an `undefined` is a legitimate "no slot claimed" case,
 * and `recordSessionArtifact` allows that) — only that a call site does not
 * DROP the parameter and silently zero out every future slot claim on that
 * door. A door that has no explicit label to offer still passes
 * `expectedLabel: someVariable` — the point is the key is written down, not that
 * it always resolves to a string.
 *
 * HOW: source-scan every `recordSessionArtifact(` call (comments stripped) and
 * require the object literal to contain the literal key `expectedLabel:`.
 */

const SRC_ROOT = join(process.cwd(), "src");

// The door's own definition, not a caller — `export async function
// recordSessionArtifact(` matches the call-site marker too (it ends in the
// same `recordSessionArtifact(` text), so it must be excluded or every run
// reports a permanent false positive against the function signature itself.
const DEFINITION_FILE = join(
  SRC_ROOT,
  "services",
  "focus-sessions",
  "record-session-artifact.ts"
);

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts") &&
      p !== DEFINITION_FILE
    ) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Find every `recordSessionArtifact(...)` call in `source` and return the text
 * of its argument object literal (balanced-paren scan — the call always takes
 * exactly one object-literal argument, but the literal itself may nest braces
 * for `props`/conditional spreads, so a regex alone would truncate early).
 */
function findCallArgs(source: string): string[] {
  const calls: string[] = [];
  const marker = "recordSessionArtifact(";
  let searchFrom = 0;
  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    let depth = 0;
    let i = start + marker.length - 1; // position of the opening "("
    let end = -1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break; // unbalanced — stop rather than loop forever
    calls.push(source.slice(start + marker.length, end));
    searchFrom = end + 1;
  }
  return calls;
}

describe("tripwire: every recordSessionArtifact() call forwards expectedLabel", () => {
  it("finds call sites (non-vacuity)", () => {
    const files = tsFiles(SRC_ROOT);
    let total = 0;
    for (const f of files) {
      total += findCallArgs(
        stripComments(readFileSync(f, "utf8"), "ts")
      ).length;
    }
    // 10 known call sites (2 human attach doors + 6 agent doors: MCP
    // synap_store_file ×2, hub documents.createDocument ×2, hub
    // views.createView, entities.create; + the two tRPC create doors,
    // `documents.create` and `views.create`, added 2026-09-07 — until then the
    // HUMAN create doors recorded nothing at all and could claim no slot).
    //
    // The floor is RAISED whenever a door is added, never left stale: a
    // non-vacuity floor that lags behind the real count tolerates a door's
    // worth of silent regression. A count that DROPS means the scan itself
    // broke (e.g. the function was renamed) — investigate rather than lower it.
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it("every call site's argument object declares an expectedLabel key", () => {
    const files = tsFiles(SRC_ROOT);
    const offenders: string[] = [];
    for (const f of files) {
      const source = stripComments(readFileSync(f, "utf8"), "ts");
      const calls = findCallArgs(source);
      for (const call of calls) {
        // Explicit key (`expectedLabel: x`) or ES2015 shorthand (`expectedLabel,`
        // / `expectedLabel }`) both count — either way the key is written down.
        const hasKey = /\bexpectedLabel\s*:/.test(call);
        const hasShorthand = /\bexpectedLabel\s*[,}]/.test(call);
        if (!hasKey && !hasShorthand) {
          offenders.push(`${f.replace(SRC_ROOT, "src")}`);
        }
      }
    }
    expect(
      offenders,
      `recordSessionArtifact() called without forwarding expectedLabel in: ${offenders.join(", ")}. ` +
        "Every call site must pass `expectedLabel:` (a variable or a literal) — omitting it silently " +
        "forecloses that door from ever claiming a declared session-output slot. If this door genuinely " +
        "has no label to offer, pass `expectedLabel: undefined` explicitly so the omission is visible in source."
    ).toEqual([]);
  });
});

/**
 * TRIPWIRE (bug #9) — a door that RECORDS the caller's slot claim on the
 * artifact must also GIVE it to the governance gate.
 *
 * The artifact's `props.expectedLabel` is read by the outputs join; the gate's
 * `opts.expectedLabel` (rung 0 of `resolveSessionSlotClaim`, resolved against
 * the row `opts.sessionId` names) is what the approval stamps `done` by. A door
 * that records the label but gates without it lets an approval stamp the FIRST
 * open slot of the kind — the documents created 2,1,3,4 swapped slots 1 and 2,
 * and the view doors (`views.create`, hub `createView` / `updateContent`) kept
 * the defect after the document door was fixed.
 *
 * HOW: every non-test source file is split into handler chunks (a tRPC
 * `.mutation(`/`.query(` or a Hono `app.<verb>(`). In a chunk whose
 * `recordSessionArtifact(` forwards a real label (not `expectedLabel: undefined`):
 *   - every `checkPermissionOrPropose(` call forwards `expectedLabel` AND
 *     `sessionId` (an identifier argument is resolved to its `const x = {…}`
 *     in the same chunk);
 *   - a procedure chunk with NO direct gate delegates — every `…Caller.create(`
 *     there must forward `expectedLabel` to the gated door it calls.
 *
 * NOT covered (measured): a gate reached through a helper function outside the
 * chunk (e.g. `createGovernedFileEntityFromBuffer`), and whether a delegate's
 * caller context carries the session handle.
 */

interface CallSite {
  arg: string;
}

function callArgs(source: string, re: RegExp): CallSite[] {
  const out: CallSite[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 0;
    let end = -1;
    for (let i = m.index + m[0].length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    out.push({ arg: source.slice(m.index + m[0].length, end) });
    re.lastIndex = end;
  }
  return out;
}

function handlerChunks(
  source: string
): { text: string; isProcedure: boolean }[] {
  const starts = [0];
  const boundary =
    /\.(?:mutation|query)\(|\bapp\.(?:get|post|put|patch|delete)\(/g;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(source))) starts.push(m.index);
  starts.push(source.length);
  const chunks: { text: string; isProcedure: boolean }[] = [];
  for (let k = 0; k < starts.length - 1; k++) {
    chunks.push({
      text: source.slice(starts[k], starts[k + 1]),
      isProcedure: k > 0,
    });
  }
  return chunks;
}

const forwards = (arg: string, key: string) =>
  new RegExp(`\\b${key}\\s*[:,}]`).test(arg);

/** Resolve `checkPermissionOrPropose(gateOpts)` to the `const gateOpts = {…}` literal. */
function resolveGateArg(chunk: string, arg: string): string {
  const id = arg.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(id)) return arg;
  const decl = new RegExp(`const\\s+${id}\\s*=\\s*\\{`).exec(chunk);
  if (!decl) return arg;
  let depth = 0;
  for (let i = decl.index + decl[0].length - 1; i < chunk.length; i++) {
    if (chunk[i] === "{") depth++;
    else if (chunk[i] === "}") {
      depth--;
      if (depth === 0) return chunk.slice(decl.index, i + 1);
    }
  }
  return arg;
}

/** Offenders in one source text; also counts the gate sites it checked. */
function gateLabelOffenders(source: string): {
  offenders: string[];
  checked: number;
} {
  const offenders: string[] = [];
  let checked = 0;
  for (const { text, isProcedure } of handlerChunks(
    stripComments(source, "ts")
  )) {
    const recordsLabel = callArgs(text, /recordSessionArtifact\(/g).some(
      (c) =>
        /\bexpectedLabel\s*:\s*(?!undefined\b)/.test(c.arg) ||
        /\bexpectedLabel\s*[,}]/.test(c.arg)
    );
    if (!recordsLabel) continue;
    const gates = callArgs(text, /checkPermissionOrPropose\(/g);
    for (const g of gates) {
      checked++;
      const literal = resolveGateArg(text, g.arg);
      if (
        !forwards(literal, "expectedLabel") ||
        !forwards(literal, "sessionId")
      ) {
        offenders.push(
          `gate: ${literal.trim().slice(0, 80).replace(/\s+/g, " ")}`
        );
      }
    }
    if (gates.length === 0 && isProcedure) {
      for (const d of callArgs(text, /\b\w*[cC]aller\.create\(/g)) {
        checked++;
        if (!forwards(d.arg, "expectedLabel")) {
          offenders.push(
            `delegation: ${d.arg.trim().slice(0, 80).replace(/\s+/g, " ")}`
          );
        }
      }
    }
  }
  return { offenders, checked };
}

describe("tripwire: a door that records expectedLabel gives it to the gate", () => {
  it("self-check: a literal recording door that gates without the label is caught", () => {
    const bad = `
      x.mutation(async ({ input, ctx }) => {
        const gateOpts = { userId, sessionId: ctx.sessionId, data: {} };
        await checkPermissionOrPropose(gateOpts);
        await recordSessionArtifact({ sessionId, expectedLabel: input.expectedLabel });
      })`;
    const good = bad.replace(
      "data: {}",
      "expectedLabel: input.expectedLabel, data: {}"
    );
    const delegating = `
      x.mutation(async ({ input, ctx }) => {
        const result = await caller.create({ name: input.name });
        await recordSessionArtifact({ sessionId, expectedLabel: input.expectedLabel });
      })`;
    expect(gateLabelOffenders(bad).offenders).toHaveLength(1);
    expect(gateLabelOffenders(good)).toEqual({ offenders: [], checked: 1 });
    expect(gateLabelOffenders(delegating).offenders).toHaveLength(1);
  });

  it("every gate in a label-recording door forwards expectedLabel + sessionId", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const f of tsFiles(SRC_ROOT)) {
      const r = gateLabelOffenders(readFileSync(f, "utf8"));
      checked += r.checked;
      for (const o of r.offenders)
        offenders.push(`${f.replace(SRC_ROOT, "src")} — ${o}`);
    }
    // Non-vacuity: tRPC views.create, hub views.createView (delegation) and
    // updateContent, hub documents.createDocument, entities.create = 5 sites.
    // A count that DROPS means the scan broke — investigate, never lower it.
    expect(checked).toBeGreaterThanOrEqual(5);
    expect(
      offenders,
      "A door records the caller's expectedLabel on the artifact but does not give it (and the " +
        "session) to the governance gate — the approval will stamp the first open slot of the kind."
    ).toEqual([]);
  });
});
