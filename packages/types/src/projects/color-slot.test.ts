import { describe, it, expect } from "vitest";
import {
  resolveProjectColorSlot,
  isProjectColorSlot,
  PROJECT_COLOR_SLOTS,
} from "./color-slot.js";

describe("resolveProjectColorSlot", () => {
  it("honours a stored choice", () => {
    expect(resolveProjectColorSlot({ id: "a", colorSlot: 7 })).toBe(7);
  });

  it("ignores an invalid stored value and derives instead", () => {
    const derived = resolveProjectColorSlot({ id: "a" });
    for (const bad of [0, 13, 2.5, Number.NaN]) {
      expect(resolveProjectColorSlot({ id: "a", colorSlot: bad })).toBe(
        derived
      );
    }
  });

  it("derives a stable slot in range from the id", () => {
    const id = "d4b84ad8-6fbe-4c09-9cee-5715be1637d9";
    const a = resolveProjectColorSlot({ id, colorSlot: null });
    expect(a).toBe(resolveProjectColorSlot({ id }));
    expect(isProjectColorSlot(a)).toBe(true);
  });

  it("spreads real ids across the palette rather than collapsing onto one slot", () => {
    // Rules out a derivation that ignores the id (e.g. a constant fallback).
    const ids = Array.from(
      { length: 48 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    const used = new Set(ids.map((id) => resolveProjectColorSlot({ id })));
    expect(used.size).toBeGreaterThanOrEqual(PROJECT_COLOR_SLOTS - 4);
  });
});
