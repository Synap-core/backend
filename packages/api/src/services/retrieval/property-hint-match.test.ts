import { describe, it, expect } from "vitest";
import { matchesHint } from "./property-hint-match.js";

describe("matchesHint", () => {
  it("matches a role value at a word boundary", () => {
    expect(
      matchesHint({ role: "VP Product" }, { key: "role", value: "vp" })
    ).toBe(true);
  });

  it("does NOT false-match 'vp' inside 'revamp' (the review-caught bug)", () => {
    expect(matchesHint({ name: "Onboarding revamp" }, { value: "vp" })).toBe(
      false
    );
  });

  it("honors the hint key — only inspects that property", () => {
    expect(
      matchesHint(
        { status: "vp", role: "manager" },
        { key: "role", value: "vp" }
      )
    ).toBe(false);
  });

  it("matches values, never key names", () => {
    expect(matchesHint({ role: "manager" }, { value: "role" })).toBe(false);
  });

  it("substring-matches longer phrase hints", () => {
    expect(
      matchesHint({ company: "Northwind Labs" }, { value: "northwind labs" })
    ).toBe(true);
  });

  it("returns false when the targeted key is absent", () => {
    expect(matchesHint({ status: "done" }, { key: "role", value: "vp" })).toBe(
      false
    );
  });

  it("ignores null/undefined property values", () => {
    expect(matchesHint({ role: null }, { key: "role", value: "vp" })).toBe(
      false
    );
  });
});
