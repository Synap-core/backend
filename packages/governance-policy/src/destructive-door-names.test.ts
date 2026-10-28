import { describe, it, expect } from "vitest";
import {
  GOVERNED_WRITE_DOORS,
  decideAgentPolicy,
  findUnsafeAutoApproveEntries,
  isDestructiveAction,
  nonWidenableFloorFor,
} from "./index.js";

/**
 * The rung-2.5 DESTRUCTIVE floor must hold on the action a door ACTUALLY
 * files, not only on the bare verbs it lists. `channel.merge_branch` (renamed
 * from `merge` so its executor key matched) escaped it: the floor matched the
 * verb exactly, so a governance rule, an `autoApproveFor` glob or an
 * agent-owned space executed a branch merge with no review.
 *
 * DERIVED, never hand-listed: every door of {@link GOVERNED_WRITE_DOORS} (the
 * typed list of `${subjectType}/${action}` pairs callers can file) whose action
 * SPELLS a destructive verb anywhere — a plain substring test, deliberately
 * looser than the predicate under test — must be floored by every check. The
 * next rename (`merge_into`, `archiveAll`, …) goes red here instead of
 * silently widening. A door that spells a destructive verb but is not
 * destructive needs a named exception in this file, with its reason.
 */
const SPELLS_DESTRUCTIVE = /delete|archive|purge|merge/i;

const destructiveDoors = Object.keys(GOVERNED_WRITE_DOORS)
  .map((door) => {
    const slash = door.indexOf("/");
    return {
      door,
      subjectType: door.slice(0, slash),
      action: door.slice(slash + 1),
    };
  })
  .filter(({ action }) => SPELLS_DESTRUCTIVE.test(action));

describe("every governed door that spells a destructive verb is floored", () => {
  it("non-vacuity: the derived set holds the bare verbs and channel/merge_branch", () => {
    const doors = destructiveDoors.map((d) => d.door);
    expect(doors).toContain("entity/delete");
    expect(doors).toContain("entity/merge");
    expect(doors).toContain("channel/merge_branch");
    expect(doors.length).toBeGreaterThan(10);
  });

  it.each(destructiveDoors)(
    "$door: isDestructiveAction, and no rung widens it",
    ({ subjectType, action }) => {
      const key = `${subjectType}.${action}`;
      expect(isDestructiveAction(action)).toBe(true);
      // A rule, a glob, the exact key, an owned space, a capability mode:
      // each on its own would execute a non-destructive write.
      for (const widen of [
        { governanceRuleVerdict: "auto" as const },
        { autoApproveFor: ["*"] },
        { autoApproveFor: [`${subjectType}.*`] },
        { autoApproveFor: [key] },
        { isAgentOwnedWorkspace: true },
        { capabilityGovernance: "auto" as const },
      ]) {
        expect(
          decideAgentPolicy({ subjectType, action, ...widen }).verdict,
          `${key} with ${JSON.stringify(widen)}`
        ).toBe("propose");
      }
      expect(nonWidenableFloorFor(key)).not.toBeNull();
      expect(findUnsafeAutoApproveEntries([key])).toEqual([key]);
    }
  );

  it("channel.merge_branch lands on the DESTRUCTIVE floor itself", () => {
    expect(nonWidenableFloorFor("channel.merge_branch")).toBe(
      "DESTRUCTIVE_HARD_FLOOR"
    );
  });

  it("a door whose action names no destructive verb is not floored by it", () => {
    for (const door of Object.keys(GOVERNED_WRITE_DOORS)) {
      const action = door.slice(door.indexOf("/") + 1);
      if (!SPELLS_DESTRUCTIVE.test(action))
        expect(isDestructiveAction(action), door).toBe(false);
    }
    expect(isDestructiveAction("create_branch")).toBe(false);
  });
});
