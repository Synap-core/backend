/**
 * A `lens-section` block's empty answer: ONE source for the web block and the
 * phone (`lensSectionDefaultEmpty`, `readLensSectionEmpty`).
 */

import { describe, expect, it } from "vitest";
import {
  ATTENTION_CLASSES,
  LENS_EMPTY_ANSWERS,
  LENS_SECTION_EMPTY_ANSWERS,
  lensSectionDefaultEmpty,
  readLensSectionEmpty,
} from "./index.js";

describe("lensSectionDefaultEmpty", () => {
  it("an empty Needs you says all is clear; every other class hides", () => {
    const answers = Object.fromEntries(
      ATTENTION_CLASSES.map((c) => [c, lensSectionDefaultEmpty(c)])
    );
    expect(answers).toEqual({
      blocking: "reassure",
      happening: "omit",
      produced: "omit",
      proposed: "omit",
      happened: "omit",
    });
  });

  it("is always an answer a block may be given", () => {
    for (const c of ATTENTION_CLASSES)
      expect(LENS_SECTION_EMPTY_ANSWERS, c).toContain(
        lensSectionDefaultEmpty(c)
      );
  });
});

describe("readLensSectionEmpty", () => {
  it("a block's answers are the lens's four minus invite", () => {
    expect([...LENS_SECTION_EMPTY_ANSWERS]).toEqual(
      LENS_EMPTY_ANSWERS.filter((a) => a !== "invite")
    );
  });

  it("reads each answer a block may be given as itself", () => {
    for (const a of LENS_SECTION_EMPTY_ANSWERS)
      expect(readLensSectionEmpty(a), a).toBe(a);
  });

  it("reads a stored legacy invite as explain (no action to offer)", () => {
    expect(readLensSectionEmpty("invite")).toBe("explain");
  });

  it("anything else names no answer", () => {
    for (const v of [undefined, null, "", "blank", "Omit", " omit", 1, {}])
      expect(readLensSectionEmpty(v), String(v)).toBeNull();
  });
});
