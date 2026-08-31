/**
 * `focus_sessions.current_stage` is documented as "seeded from the playbook's
 * first stage on instantiation". createFocusSession wired `playbookId` but
 * never seeded the stage, so a session started from a staged playbook was born
 * NULL-staged and every stage-aware surface read it as stageless — verified
 * live before the fix (origin "playbook", playbookId set, currentStage null).
 *
 * Service integration needs a DB; this pins the seeding rule itself.
 */
import { describe, it, expect } from "vitest";
import { firstStageKey } from "../create-session.js";

describe("firstStageKey — playbook stage seeding", () => {
  it("seeds from the first stage's key", () => {
    expect(
      firstStageKey([
        { key: "brainstorming", name: "Brainstorming", category: "planned" },
        { key: "validating", name: "Validating", category: "planned" },
      ])
    ).toBe("brainstorming");
  });

  it("stays NULL for a stageless playbook (stages: []) — not a fabricated stage", () => {
    expect(firstStageKey([])).toBeNull();
  });

  it("stays NULL when the playbook has no stages at all", () => {
    expect(firstStageKey(undefined)).toBeNull();
    expect(firstStageKey(null)).toBeNull();
  });

  it("is defensive about JSONB shape — never returns a non-string key", () => {
    expect(firstStageKey("not-an-array")).toBeNull();
    expect(firstStageKey([null])).toBeNull();
    expect(firstStageKey([{ name: "no key here" }])).toBeNull();
    expect(firstStageKey([{ key: 42 }])).toBeNull();
    expect(firstStageKey([{ key: "" }])).toBeNull();
  });
});
