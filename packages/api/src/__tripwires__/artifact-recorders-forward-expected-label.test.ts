import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

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
      total += findCallArgs(stripComments(readFileSync(f, "utf8"))).length;
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
      const source = stripComments(readFileSync(f, "utf8"));
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
