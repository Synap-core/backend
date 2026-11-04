/**
 * A section's tally: after the title, never a "0", never an exact number
 * past 99. The placement (inside the heading, not under it) is pinned in
 * section-card.test.tsx.
 */
import { describe, expect, it } from "vitest";
import { sectionCountLabel } from "./section-count";

describe("sectionCountLabel", () => {
  it("spells a positive count, and says nothing when it is zero or unread", () => {
    expect(sectionCountLabel(2)).toBe("2");
    expect(sectionCountLabel(1.9)).toBe("1");
    expect(sectionCountLabel(0)).toBeNull();
    expect(sectionCountLabel(-4)).toBeNull();
    expect(sectionCountLabel(null)).toBeNull();
    expect(sectionCountLabel(undefined)).toBeNull();
    expect(sectionCountLabel(Number.NaN)).toBeNull();
  });

  it("caps at 99+", () => {
    expect(sectionCountLabel(99)).toBe("99");
    expect(sectionCountLabel(100)).toBe("99+");
    expect(sectionCountLabel(340)).toBe("99+");
  });
});
