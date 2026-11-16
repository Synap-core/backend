/**
 * Which edits bump a playbook's `version` (`DEFINITION_VERSION_FIELDS`), so a
 * run's recorded version tells "what ran" apart from "today".
 *
 * Every field a kept version holds (`PLAYBOOK_VERSION_FIELDS`) is CLASSIFIED:
 * it bumps the version, or it is kept without bumping for a stated reason. The
 * set is derived from the kept fields, so a field added to a version without
 * a decision fails here.
 */
import { describe, expect, it } from "vitest";
import {
  DEFINITION_VERSION_FIELDS,
  definitionVersionChanged,
} from "./definition-version.js";
import { PLAYBOOK_VERSION_FIELDS } from "./playbook-versions.js";

/** Kept in a version so a run can read it as a playbook, but no bump: why. */
const KEPT_WITHOUT_BUMP: Record<string, string> = {
  name: "a rename does not change what a run does",
  description: "prose for people; a run is not told it",
  subjectProfile:
    "the kind it works on; its stages carry the moves (next lane)",
  scope: "where it may be started from, not what a run does (next lane)",
};

describe("definition version", () => {
  it("every kept field bumps the version or is kept without a bump for a reason", () => {
    const bumping = new Set<string>(DEFINITION_VERSION_FIELDS);
    const unclassified = PLAYBOOK_VERSION_FIELDS.filter(
      (f) => !bumping.has(f) && !(f in KEPT_WITHOUT_BUMP)
    );
    expect(unclassified).toEqual([]);
    // Non-vacuous: both sides hold fields.
    expect(bumping.size).toBeGreaterThan(5);
    expect(Object.keys(KEPT_WITHOUT_BUMP).length).toBeGreaterThan(0);
  });

  it("an executor-only change bumps the version (agent session → one-shot)", () => {
    expect(
      definitionVersionChanged(
        { executor: "generate" },
        { executor: "is-agent", goalTemplate: "Write the brief" }
      )
    ).toBe(true);
    expect(
      definitionVersionChanged(
        { executor: "is-agent" },
        { executor: "is-agent", goalTemplate: "Write the brief" }
      )
    ).toBe(false);
  });
});
