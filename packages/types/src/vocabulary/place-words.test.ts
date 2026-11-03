/**
 * Place words — the one source of "Everywhere in your pod", "Anywhere you can
 * reach" and a space list. Rules out a surface writing its own copy.
 */
import { describe, expect, it } from "vitest";
import {
  EVERYWHERE_IN_POD,
  POD_WIDE_HEADING,
  resolveObjectNoun,
  resolvePlaceLabel,
  resolvePlacePhrase,
  resolveSpacesLabel,
} from "./index.js";

const names = { a: "Sales", b: "Finance", c: "Ops" };

describe("place words", () => {
  it.each([
    [
      { kind: "pod" } as const,
      "Everywhere in your pod",
      "everywhere in your pod",
    ],
    [
      { kind: "unbounded" } as const,
      "Anywhere you can reach",
      "anywhere you can reach",
    ],
    [{ kind: "spaces", ids: ["a"] } as const, "Sales", "in Sales"],
    [
      { kind: "spaces", ids: ["a", "b"] } as const,
      "Sales and Finance",
      "in Sales and Finance",
    ],
  ])("%j → %s / %s", (place, label, phrase) => {
    expect(resolvePlaceLabel(place, names)).toBe(label);
    expect(resolvePlacePhrase(place, names)).toBe(phrase);
  });

  it("more than two spaces are counted; an unknown name is never a raw id", () => {
    expect(resolveSpacesLabel(["a", "b", "c"], names)).toMatch(/^3 /);
    expect(resolveSpacesLabel(["zz"], names)).toBe(
      resolveObjectNoun("workspace")
    );
  });

  it("the pod-wide constants are the place words", () => {
    expect(POD_WIDE_HEADING).toBe(resolvePlaceLabel({ kind: "pod" }));
    expect(EVERYWHERE_IN_POD).toBe(resolvePlacePhrase({ kind: "pod" }));
  });
});
