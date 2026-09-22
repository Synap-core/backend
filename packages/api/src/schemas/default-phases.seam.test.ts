/**
 * THE SEAM: the shared default phase skeleton must be accepted by the REAL
 * write door, not by a hand-built fixture that resembles it.
 *
 * `DEFAULT_PLAYBOOK_PHASES` lives in `@synap-core/types` (dependency-free, so
 * the UI packages can import it) while `playbookStagesSchema` lives here at the
 * door. Nothing type-links the two: the constant is structurally typed and the
 * schema is a `looseObject`, so a default that drifted — a missing `category`,
 * a key with whitespace, a duplicate — would typecheck perfectly and fail only
 * at runtime, on a person's first playbook, as "Could not create the playbook."
 *
 * This drives the ACTUAL schema over the ACTUAL constant. Nothing in between is
 * hand-written, which is the whole point: an assertion built from a literal
 * copy of the phases would pass while the shipped constant was broken.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBOOK_PHASES,
  defaultPlaybookPhases,
} from "@synap-core/types/units";
import { playbookStagesSchema } from "./playbook-stage.js";

describe("the default phase skeleton is accepted by the real door", () => {
  it("validates, unmodified", () => {
    const parsed = playbookStagesSchema.safeParse(defaultPlaybookPhases());
    // Print the door's own complaint rather than a bare `false`.
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("the scan is not vacuous — there really are phases to check", () => {
    // A constant that silently emptied would pass every assertion above: an
    // empty array is a valid stage list.
    expect(DEFAULT_PLAYBOOK_PHASES.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_PLAYBOOK_PHASES.map((p) => p.key)).toContain("gather");
  });

  it("every phase carries the category the door REQUIRES", () => {
    // `category` is the closed cross-playbook rollup axis and is mandatory at
    // every write boundary. It is the one field a hand-authored default is
    // most likely to omit, because the TS type would not force it.
    for (const phase of DEFAULT_PLAYBOOK_PHASES) {
      expect(phase.category, `"${phase.key}" has no category`).toBeTruthy();
    }
  });

  it("returns a FRESH copy — the caller hands it to a form that mutates", () => {
    const a = defaultPlaybookPhases();
    const b = defaultPlaybookPhases();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    a[0]!.name = "Renamed by a form";
    // The module-level constant, and every later caller, are untouched.
    expect(b[0]!.name).toBe(DEFAULT_PLAYBOOK_PHASES[0]!.name);
  });
});
