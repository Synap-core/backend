import { describe, expect, it } from "vitest";

import { satisfiesRange } from "./semver-range.mjs";

describe("satisfiesRange: true, false, or could-not-evaluate", () => {
  it("a caret range accepts a later minor of the same major (the 2026-10-21 false red)", () => {
    expect(satisfiesRange("1.31.0", "^1.25.7")).toBe(true);
  });

  it("a caret range refuses the next major and an older version", () => {
    expect(satisfiesRange("2.0.0", "^1.25.7")).toBe(false);
    expect(satisfiesRange("1.25.6", "^1.25.7")).toBe(false);
  });

  it("caret below 1.0 fixes the left-most non-zero part", () => {
    expect(satisfiesRange("0.4.9", "^0.4.1")).toBe(true);
    expect(satisfiesRange("0.5.0", "^0.4.1")).toBe(false);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("tilde, exact and >= ranges", () => {
    expect(satisfiesRange("1.25.9", "~1.25.7")).toBe(true);
    expect(satisfiesRange("1.26.0", "~1.25.7")).toBe(false);
    expect(satisfiesRange("1.25.7", "1.25.7")).toBe(true);
    expect(satisfiesRange("1.25.8", "=1.25.7")).toBe(false);
    expect(satisfiesRange("3.0.0", ">=1.25.7")).toBe(true);
    expect(satisfiesRange("1.0.0", "*")).toBe(true);
  });

  it("a range it cannot read is null — never folded into false", () => {
    expect(satisfiesRange("1.31.0", "workspace:*")).toBeNull();
    expect(satisfiesRange("1.31.0", "^1.0.0 || ^2.0.0")).toBeNull();
    expect(satisfiesRange("1.31.0-beta.1", "^1.25.7")).toBeNull();
  });
});
