import { describe, it, expect } from "vitest";
import {
  REVERSIBILITY_DOOR_CLASS,
  decideAgentPolicy,
  isReversibleWrite,
  matchesActionPattern,
} from "./index.js";

/**
 * `entities.restore` (the undo of a delete) asks an agent for a proposal
 * exactly where its delete does: by default, and under the pod's `@reversible`
 * auto rule. Undoing a restore is a delete, which an agent can only propose,
 * so the restore is not "easily reversible" for the actor.
 *
 * NEGATIVE CONTROL: classify `entity/restore` as reversible and the
 * `@reversible` assertions go red.
 */
describe("entity.restore — agent parity with entity.delete", () => {
  it("is classified disruptive, so the @reversible rule never covers it", () => {
    expect(REVERSIBILITY_DOOR_CLASS["entity/restore"]).toBe("disruptive");
    expect(isReversibleWrite("entity.restore")).toBe(false);
    expect(matchesActionPattern("entity.restore", ["@reversible"])).toBe(false);
  });

  it("an agent with no rule proposes both, at the default rung", () => {
    const restore = decideAgentPolicy({
      subjectType: "entity",
      action: "restore",
    });
    const del = decideAgentPolicy({ subjectType: "entity", action: "delete" });
    expect(del.verdict).toBe("propose");
    expect(restore.verdict).toBe("propose");
  });
});
