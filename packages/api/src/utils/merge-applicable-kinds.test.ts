import { describe, it, expect } from "vitest";
import { mergeApplicableKinds } from "./merge-applicable-kinds.js";

describe("mergeApplicableKinds", () => {
  it("NULL existing means any kind — add is a no-op", () => {
    expect(mergeApplicableKinds(null, ["item"])).toEqual({
      next: null,
      widened: false,
    });
  });

  it("appends new kinds and preserves order", () => {
    expect(mergeApplicableKinds(["company"], ["person", "item"])).toEqual({
      next: ["company", "person", "item"],
      widened: true,
    });
  });

  it("does not shrink or duplicate", () => {
    expect(mergeApplicableKinds(["company", "person"], ["person"])).toEqual({
      next: ["company", "person"],
      widened: false,
    });
  });

  it("fills an empty allowlist (broken role) by adding", () => {
    expect(mergeApplicableKinds([], ["item"])).toEqual({
      next: ["item"],
      widened: true,
    });
  });
});
