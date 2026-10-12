/**
 * `optional` on a declared slot (ExpectedOutput.optional) is CLIENT-
 * DECLARABLE and erasure-protected: kept wherever a slot is born — the
 * playbook/stage declaration through `sanitizeDeclaredOutputs` (run birth,
 * stage entry, follow) and a new slot in a wholesale patch — and kept by a
 * patch that is silent about it.
 *
 * Rivals ruled out:
 *   - optional stripped like a stamp → a declared optional slot is born
 *     required, and an `at-close` engagement's milestone invoice sits in
 *     "needs you" forever (the defect this field exists for);
 *   - optional missing from the erasure list → a client that never heard of
 *     it renames a sibling and the invoice is owed again.
 */
import { describe, it, expect } from "vitest";
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
  it("a declared optional slot is born optional", () => {
    const [kept] = sanitizeDeclaredOutputs([INVOICE]);
    expect(kept).toMatchObject({ label: "Milestone invoice", optional: true });
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

  it("a stored optional slot keeps it through a patch that is silent about it", () => {
    const stored = sanitizeDeclaredOutputs([INVOICE]);
    const { optional: _o, ...silent } = stored[0]!;
    const next = mergeExpectedOutputs(stored, [
      { ...silent, why: "the Q3 milestone" },
    ]);
    expect(next[0]).toMatchObject({ why: "the Q3 milestone", optional: true });
  });
});
