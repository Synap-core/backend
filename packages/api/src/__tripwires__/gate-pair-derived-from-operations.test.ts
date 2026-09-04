import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the gate's (subjectType, action) pair is DERIVED from the
 * operations, never DECLARED beside them.
 *
 * THE DEFECT CLASS. `routers/capture.ts` called `checkPermissionOrPropose` with
 * hardcoded literals:
 *
 *     subjectType: "entity",
 *     action: "create",
 *     data: { operations: gateOperations, source: "capture" }
 *
 * …while `gateOperations` was a real `CompositeProposalOperation[]`. Every
 * governance floor is a pure function of exactly those two literals — rung 2
 * `ADMIN_ACTIONS.includes(eventKey)` (strict equality, NO globbing), rung 2.5
 * `DESTRUCTIVE_ACTIONS.includes(action)`, rung 2.6 by-kind — so the floors were
 * scoring a DECLARATION rather than the write. It was true only by coincidence:
 * capture can emit `create_entity` / `create_relation` and nothing else. The
 * instant a producer emits another arm (`update`, `create_skill`,
 * `create_automation`, `create_rule`), the gate would still say `entity`/
 * `create` and a floor could never fire on the arm that needed it. A DESTRUCTIVE
 * floor cannot fire on a door that says "create".
 *
 * THE RULE: a batch gates at its STRICTEST member, via
 * `deriveGatePairFromOperations` (`@synap/governance-policy`). Over-gating is
 * safe; under-gating is the bug.
 *
 * A SOURCE SCAN is the only mechanism that can see this. The severance is a
 * literal at a call site: the types accept it (both spellings are legal gate
 * doors), the call succeeds, and no runtime assertion can tell a coincidentally
 * correct declaration from a derived one.
 */

const API_SRC = join(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    // Tests may legitimately construct literal gate options as fixtures.
    if (name.includes(".test.ts") || full.includes("__tests__")) continue;
    out.push(full);
  }
  return out;
}

/** The balanced-paren argument text of every `checkPermissionOrPropose(` call. */
function gateCallArguments(src: string): string[] {
  const calls: string[] = [];
  const marker = "checkPermissionOrPropose(";
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
    calls.push(src.slice(at, i + 1));
    from = i + 1;
  }
  return calls;
}

describe("TRIPWIRE: gate pair is derived from data.operations", () => {
  const files = collectSourceFiles(API_SRC);

  it("finds the gate call sites it is supposed to police", () => {
    const withGate = files.filter((f) =>
      readFileSync(f, "utf8").includes("checkPermissionOrPropose(")
    );
    // A scan that matches nothing proves nothing. This is the floor.
    expect(withGate.length).toBeGreaterThan(20);
  });

  it("no gate call passes a LITERAL action beside data.operations", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("checkPermissionOrPropose(")) continue;
      for (const call of gateCallArguments(src)) {
        // Only calls that carry a composite operations batch are in scope: a
        // single-op door that declares its own matching pair is correct.
        if (!/\boperations\s*:/.test(call)) continue;
        const literalAction = /\baction\s*:\s*["'`]/.test(call);
        const literalSubject = /\bsubjectType\s*:\s*["'`]/.test(call);
        if (literalAction || literalSubject) {
          offenders.push(
            `${file.slice(API_SRC.length + 1)} — ${
              literalAction ? "literal action" : ""
            }${literalAction && literalSubject ? " + " : ""}${
              literalSubject ? "literal subjectType" : ""
            } alongside data.operations`
          );
        }
      }
    }
    expect(
      offenders,
      "A gate call carrying a composite `data.operations` batch must derive its " +
        "pair with `deriveGatePairFromOperations(ops)` from @synap/governance-policy. " +
        "A literal pair beside the batch makes every governance floor score a " +
        "declaration instead of the write."
    ).toEqual([]);
  });

  it("the known composite gate doors actually call the derivation", () => {
    // Positive half: the scan above passes trivially if the call sites vanish.
    for (const rel of ["routers/capture.ts", "utils/capture-propose.ts"]) {
      const src = readFileSync(join(API_SRC, rel), "utf8");
      expect(src, rel).toContain("deriveGatePairFromOperations");
    }
  });
});
