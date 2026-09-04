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
    if (name.includes(".test.ts") || full.includes("__tests__")) continue;
    // The materializer itself, and the factory it documents.
    if (name === "materialize-composite.ts") continue;
    out.push(full);
  }
  return out;
}

describe("TRIPWIRE: Rule Loop callers wired at every materialize call site", () => {
  const callers = collectSourceFiles(API_SRC).filter((f) =>
    readFileSync(f, "utf8").includes("await materializeCompositeGraph(")
  );

  it("finds the call sites it is supposed to police", () => {
    // Four production call sites at the time of writing. A scan that matches
    // nothing proves nothing.
    expect(callers.length).toBeGreaterThanOrEqual(4);
  });

  it("every call site wires the callers through the ONE factory", () => {
    const unwired = callers
      .filter((f) => !readFileSync(f, "utf8").includes("buildRuleLoopCallers"))
      .map((f) => f.slice(API_SRC.length + 1));
    expect(
      unwired,
      "Each `materializeCompositeGraph` caller must spread " +
        "`buildRuleLoopCallers({...})` (utils/rule-loop-callers.ts) into its options. " +
        "An unwired call site drops create_skill / create_automation / create_rule ops, " +
        "which is how materialization forks on governance state."
    ).toEqual([]);
  });

  it("the materializer refuses an unwired config op instead of skipping it", () => {
    const src = readFileSync(
      join(API_SRC, "utils/materialize-composite.ts"),
      "utf8"
    );
    // The fail-closed preflight, and no surviving silent-skip shape.
    expect(src).toContain("wired no matching caller");
    expect(src).not.toMatch(
      /no (skill|automation|rule)Caller wired by this caller/
    );
  });
});
