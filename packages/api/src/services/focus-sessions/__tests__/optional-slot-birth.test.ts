/**
 * `optional` on a declared slot is a BIRTH declaration (ExpectedOutput.optional):
 * kept wherever a slot is born — the playbook/stage declaration through
 * `sanitizeDeclaredOutputs` (run birth, stage entry, follow), and a new slot
 * in a wholesale patch — and never changeable on a stored slot, so an agent
 * cannot excuse itself from a required deliverable (or the stage gate) after
 * the fact.
 *
 * Rivals ruled out:
 *   - optional left CLIENT-declarable → a patch flips a stored slot optional;
 *   - optional stripped like every other stamped field → a declared optional
 *     slot is born required, and an `at-close` engagement's milestone invoice
 *     sits in "needs you" forever (the defect this field exists for);
 *   - a truthy keep → `optional: "false"` is born optional.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  mergeExpectedOutputs,
  sanitizeDeclaredOutputs,
} from "../update-session.js";
import { stageSlotsToAdd } from "../stage-slots.js";

const INVOICE = {
  kind: "invoice",
  label: "Milestone invoice",
  owner: "human" as const,
  optional: true,
};

describe("optional slots are declared at birth", () => {
  it("a declared optional slot is born optional; a non-`true` value is not kept", () => {
    const [kept, notKept] = sanitizeDeclaredOutputs([
      INVOICE,
      {
        kind: "report",
        label: "Acceptance",
        optional: "false" as unknown as boolean,
      },
    ]);
    expect(kept).toMatchObject({ label: "Milestone invoice", optional: true });
    expect(notKept).not.toHaveProperty("optional");
  });

  it("entering a stage that declares an optional slot adds it optional", () => {
    const stages = [{ key: "accepted", expectedOutputs: [INVOICE] }];
    const added = stageSlotsToAdd(stages, "accepted", []);
    expect(added).toEqual([
      expect.objectContaining({ label: "Milestone invoice", optional: true }),
    ]);
  });

  it("a NEW slot in a wholesale patch may be born optional", () => {
    const next = mergeExpectedOutputs([], [INVOICE]);
    expect(next[0]).toMatchObject({ optional: true });
  });

  it("a STORED required slot can never be flipped optional by a patch", () => {
    const stored: ExpectedOutput[] = sanitizeDeclaredOutputs([
      { kind: "report", label: "Acceptance note", owner: "human" },
    ]);
    expect(() =>
      mergeExpectedOutputs(stored, [{ ...stored[0]!, optional: true }])
    ).toThrow(/optional/);
  });

  it("a stored optional slot keeps it through a patch that is silent about it", () => {
    const stored = sanitizeDeclaredOutputs([INVOICE]);
    const { optional: _o, ...silent } = stored[0]!;
    const next = mergeExpectedOutputs(stored, [
      { ...silent, why: "the Q3 milestone" },
    ]);
    expect(next[0]).toMatchObject({ why: "the Q3 milestone", optional: true });
  });
});
