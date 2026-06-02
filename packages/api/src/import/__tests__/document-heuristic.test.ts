import { describe, it, expect } from "vitest";
import { shouldMaterializeAsDocument } from "@synap-core/types/documents";

describe("shouldMaterializeAsDocument", () => {
  it("returns false for empty / whitespace-only content", () => {
    expect(shouldMaterializeAsDocument("")).toBe(false);
    expect(shouldMaterializeAsDocument("   \n  ")).toBe(false);
  });

  it("returns false for a short one-liner fact", () => {
    expect(shouldMaterializeAsDocument("Alice prefers async comms")).toBe(
      false
    );
  });

  it("returns true when length ≥ 600 chars", () => {
    expect(shouldMaterializeAsDocument("a".repeat(600))).toBe(true);
    expect(shouldMaterializeAsDocument("a".repeat(599))).toBe(false);
  });

  it("returns true with ≥2 markdown headings", () => {
    expect(
      shouldMaterializeAsDocument("# Title\nintro\n## Section\nbody")
    ).toBe(true);
  });

  it("returns false with a single heading and little else", () => {
    expect(shouldMaterializeAsDocument("# Just a title")).toBe(false);
  });

  it("returns true when a code fence is present", () => {
    expect(shouldMaterializeAsDocument("Here:\n```ts\nconst x = 1;\n```")).toBe(
      true
    );
  });

  it("returns true with ≥3 list items", () => {
    expect(shouldMaterializeAsDocument("- one\n- two\n- three")).toBe(true);
    expect(shouldMaterializeAsDocument("1. one\n2. two\n3. three")).toBe(true);
  });

  it("returns false with only 2 list items", () => {
    expect(shouldMaterializeAsDocument("- one\n- two")).toBe(false);
  });

  it("returns true with ≥4 blank-line paragraphs", () => {
    expect(shouldMaterializeAsDocument("p1\n\np2\n\np3\n\np4")).toBe(true);
  });

  it("returns false with only 3 paragraphs", () => {
    expect(shouldMaterializeAsDocument("p1\n\np2\n\np3")).toBe(false);
  });
});
