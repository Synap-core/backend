/**
 * The sentence a person reads before agreeing to a data change must say what
 * the op does: an in-place value remap (sourceKey === targetKey) removes
 * nothing, and must not say it does (dogfood 2026-10-14: the Builder update
 * read "move storyStatus onto storyStatus … then remove storyStatus").
 */
import { describe, it, expect } from "vitest";
import { describeConversionOp } from "./data-changes.js";
import { CONVERSION_MANIFEST } from "./manifest.js";

type Op = Parameters<typeof describeConversionOp>[0];

describe("describeConversionOp — remapPropertyValues", () => {
  it("an in-place remap says it translates values, never that it removes the field", () => {
    const op = CONVERSION_MANIFEST.ops.find(
      (o) => (o as { opKey?: string }).opKey === "h0.devplane-story.planned"
    ) as Op | undefined;
    expect(op, "manifest op h0.devplane-story.planned").toBeDefined();
    const sentence = describeConversionOp(op!);
    expect(sentence).toBe(
      'Translate the old "storyStatus" values of each "devplane_story" to the new ones.'
    );
    expect(sentence).not.toMatch(/remove/);
  });

  it("a remap onto another key still says it moves and removes the old key", () => {
    const op = {
      op: "remapPropertyValues",
      opKey: "test.move",
      slug: "decision",
      sourceKey: "status",
      targetKey: "decisionStatus",
      valueMap: { accepted: "accepted" },
    } as unknown as Op;
    expect(describeConversionOp(op)).toBe(
      'Move each "decision"\'s "status" onto "decisionStatus", translating the values, then remove "status".'
    );
  });
});
