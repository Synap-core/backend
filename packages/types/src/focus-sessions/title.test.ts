import { describe, it, expect } from "vitest";
import {
  resolveSessionTitle,
  normalizeSessionTitle,
  SESSION_TITLE_FALLBACK_MAX,
} from "./index.js";

describe("resolveSessionTitle", () => {
  it("prefers the title over the goal", () => {
    expect(
      resolveSessionTitle({ title: "Billing launch", goal: "Ship billing" })
    ).toBe("Billing launch");
  });

  it("trims and one-lines the title", () => {
    expect(
      resolveSessionTitle({ title: "  Billing\n launch ", goal: "x" })
    ).toBe("Billing launch");
  });

  it("falls back to the goal's first non-empty line when the title is blank", () => {
    expect(
      resolveSessionTitle({
        title: "   ",
        goal: "\n  Ship billing  \nThen invoice everyone",
      })
    ).toBe("Ship billing");
    expect(resolveSessionTitle({ title: null, goal: "Ship billing" })).toBe(
      "Ship billing"
    );
    expect(resolveSessionTitle({ goal: "Ship billing" })).toBe("Ship billing");
  });

  it("clips a paragraph goal at a word boundary with an ellipsis", () => {
    const goal =
      "Research the best web scraping approaches for social media platforms, then compare vendors and write a recommendation memo";
    const out = resolveSessionTitle({ goal });
    expect(out.length).toBeLessThanOrEqual(SESSION_TITLE_FALLBACK_MAX);
    expect(out.endsWith("…")).toBe(true);
    // Word boundary: the character before the ellipsis ends a whole word of the goal.
    const body = out.slice(0, -1);
    expect(goal.startsWith(body)).toBe(true);
    expect(goal[body.length]).toMatch(/[\s,]/);
  });

  it("does not clip the user's own title", () => {
    const title = "A".repeat(150);
    expect(resolveSessionTitle({ title, goal: "x" })).toBe(title);
  });

  it("honours a custom maxLength and cuts a single long word mid-word", () => {
    expect(
      resolveSessionTitle({ goal: "Supercalifragilistic" }, { maxLength: 8 })
    ).toBe("Superca…");
  });

  it("returns an empty string only when both are empty", () => {
    expect(resolveSessionTitle({ title: "", goal: "" })).toBe("");
    expect(resolveSessionTitle({})).toBe("");
  });
});

describe("normalizeSessionTitle", () => {
  it("is null for absent or blank input and one-lines the rest", () => {
    expect(normalizeSessionTitle(undefined)).toBeNull();
    expect(normalizeSessionTitle(null)).toBeNull();
    expect(normalizeSessionTitle(" \n ")).toBeNull();
    expect(normalizeSessionTitle(" a\n\tb ")).toBe("a b");
  });
});
