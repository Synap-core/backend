/**
 * The GOAL JUDGEMENT types (`JUDGEMENT_NOTIFICATION_TYPES`, @synap-core/types
 * lens) are ranked first in the Inbox by the client rule
 * (`needs-you/buckets.ts`). That only means something if the pod declares
 * them and puts them in Needs you. This holds the list to the registry:
 *
 *   - every judgement type is a registry type and an Inbox ITEM (never a
 *     banner, a suggestion or informational — those never reach the rank);
 *   - every goal (`track.*`) type in the registry is CLASSIFIED, a judgement
 *     or a named nudge — the scanned set is the registry's own, so a new goal
 *     notification fails here until someone decides whether it is a verdict.
 *
 * Not covered: whether a judgement type has a producer (the producer
 * allowlist tripwire holds that), nor that the client ranks it first (the
 * types `buckets.test.ts` does).
 */
import { describe, expect, it } from "vitest";
import { JUDGEMENT_NOTIFICATION_TYPES } from "@synap-core/types/lens";
import { NOTIFICATION_REGISTRY, needsYouRole } from "../registry.js";

/** Goal notifications that are NOT a verdict, and why. */
const GOAL_NUDGES: Record<string, string> = {
  "track.kpi_reached":
    "a nudge to re-aim a number; reaching it never decides the goal",
  "track.blocker_ended":
    "news that a goal this one waited on closed or was dropped; nothing to judge",
  "track.loop_stopped":
    "the loop paused on a criterion that failed twice; the owner re-plans or regrades in the goal, the verdict stays the judge's",
  "track.signal":
    "the status watcher: a paused goal is due for review; the owner resumes it or says what it waits on, nothing is judged",
};

describe("goal judgement types: client list ⇔ pod registry", () => {
  const goalTypes = NOTIFICATION_REGISTRY.map((d) => d.type).filter((t) =>
    t.startsWith("track.")
  );

  it("non-vacuity: the registry declares goal notifications", () => {
    expect(goalTypes.length).toBeGreaterThanOrEqual(3);
    expect(JUDGEMENT_NOTIFICATION_TYPES.size).toBeGreaterThan(0);
  });

  it("every judgement type is declared, and reaches Needs you as an item", () => {
    for (const type of JUDGEMENT_NOTIFICATION_TYPES) {
      expect(goalTypes, type).toContain(type);
      expect(needsYouRole(type), type).toBe("item");
    }
  });

  it("every goal notification is classified: a judgement or a named nudge", () => {
    const unclassified = goalTypes.filter(
      (t) => !JUDGEMENT_NOTIFICATION_TYPES.has(t) && !(t in GOAL_NUDGES)
    );
    expect(unclassified).toEqual([]);
    for (const t of Object.keys(GOAL_NUDGES)) {
      expect(JUDGEMENT_NOTIFICATION_TYPES.has(t), t).toBe(false);
    }
  });
});
