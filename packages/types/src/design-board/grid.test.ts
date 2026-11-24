/**
 * The grid as data: columns per width class, the class a frame width draws
 * at, and what a stored span or hide keeps.
 */
import { describe, expect, it } from "vitest";
import { FRAME_PRESETS } from "./board.js";
import {
  GRID_COLUMNS,
  cleanGridProp,
  fitStartToSpan,
  fitsPlacement,
  widthClassOf,
} from "./grid.js";

describe("the page grid", () => {
  it("12 / 8 / 4 columns at expanded / medium / compact", () => {
    expect(GRID_COLUMNS).toEqual({ compact: 4, medium: 8, expanded: 12 });
  });

  it("the frame presets draw at the classes the plan names: 1440 and 1280 expanded, 834 medium, 390 compact", () => {
    expect(
      Object.fromEntries(FRAME_PRESETS.map((p) => [p.id, widthClassOf(p.w)]))
    ).toEqual({
      desktop: "expanded",
      laptop: "expanded",
      tablet: "medium",
      phone: "compact",
    });
  });

  it("the breakpoints are 600 and 1024, each the first width of its class", () => {
    expect([599, 600, 1023, 1024].map(widthClassOf)).toEqual([
      "compact",
      "medium",
      "medium",
      "expanded",
    ]);
  });

  it("a stored span keeps whole numbers of the class's columns; a hide keeps booleans; the rest is named bad", () => {
    expect(
      cleanGridProp("span", { compact: 4, medium: 9, expanded: 12 })
    ).toEqual({
      value: { compact: 4, expanded: 12 },
      bad: true,
    });
    expect(cleanGridProp("hide", { compact: true, wide: true })).toEqual({
      value: { compact: true },
      bad: true,
    });
    expect(cleanGridProp("span", 3)).toEqual({ value: undefined, bad: true });
  });

  it("a stored start keeps a column of the class; an undefined class is not set, and not bad", () => {
    expect(
      cleanGridProp("start", { compact: 4, medium: 0, expanded: undefined })
    ).toEqual({ value: { compact: 4 }, bad: true });
    expect(cleanGridProp("start", { expanded: undefined })).toEqual({
      value: undefined,
      bad: false,
    });
  });

  it("a start fits with its span (s + n - 1 <= columns); with no span it runs to the row's end", () => {
    expect(fitsPlacement("expanded", 9, 4)).toBe(true);
    expect(fitsPlacement("expanded", 10, 4)).toBe(false);
    expect(fitsPlacement("compact", 4, undefined)).toBe(true);
    expect(
      fitStartToSpan({ expanded: 10, compact: 2 }, { expanded: 4, compact: 3 })
    ).toEqual({ value: { compact: 2 }, bad: true });
    expect(fitStartToSpan(undefined, { expanded: 4 })).toEqual({
      value: undefined,
      bad: false,
    });
  });
});
