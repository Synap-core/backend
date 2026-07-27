/**
 * The backend half of the goal ⇄ params check. `findUnresolvedReferences` is
 * already pinned by `command-template.test.ts`; what is NOT covered anywhere is
 * the adapter that reads declared names off the loose `playbooks.params` JSONB —
 * which is exactly where a wrong field name would silently report "nothing
 * unresolved" for every playbook and make the whole door a no-op.
 */
import { describe, expect, it } from "vitest";
import { findUnresolvedGoalReferences } from "./goal-references.js";

describe("findUnresolvedGoalReferences", () => {
  it("a goal fully backed by declared params is clean", () => {
    expect(
      findUnresolvedGoalReferences("Compare {ourSpace} against {competitor}", [
        { name: "ourSpace", type: "text" },
        { name: "competitor", type: "text" },
      ])
    ).toEqual([]);
  });

  it("flags a placeholder no declared param backs", () => {
    expect(
      findUnresolvedGoalReferences("Compare {ourSpace} against {competitor}", [
        { name: "ourSpace", type: "text" },
      ])
    ).toEqual([{ text: "{competitor}", kind: "unknown-arg" }]);
  });

  it("reads the `name` field — a params array of other shapes declares nothing", () => {
    // The guard against the adapter silently matching on the wrong key: if this
    // returned [] the door would pass everything.
    expect(
      findUnresolvedGoalReferences("Check {competitor}", [
        { label: "competitor", type: "text" },
      ])
    ).toEqual([{ text: "{competitor}", kind: "unknown-arg" }]);
  });

  it("tolerates missing / non-array params and a missing goal", () => {
    expect(findUnresolvedGoalReferences("Check {competitor}", null)).toEqual([
      { text: "{competitor}", kind: "unknown-arg" },
    ]);
    expect(findUnresolvedGoalReferences(null, [])).toEqual([]);
    expect(findUnresolvedGoalReferences("", [])).toEqual([]);
  });

  it("leaves grammar-#3 {{path}} bindings alone (a different resolver owns them)", () => {
    expect(
      findUnresolvedGoalReferences("Use {{trigger.payload.prompt}}", [])
    ).toEqual([]);
  });

  it("reports braced text no rule matches as unsupported", () => {
    expect(findUnresolvedGoalReferences("see {the notes}", [])).toEqual([
      { text: "{the notes}", kind: "unsupported" },
    ]);
  });
});
