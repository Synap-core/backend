/**
 * `readStageLessons` — the tolerant reader of a stage's lessons bag.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_STAGE_LESSONS,
  readStageLessons,
  STAGE_LESSON_MAX_CHARS,
} from "./index.js";

describe("readStageLessons", () => {
  it("a legacy stage (no lessons) and a non-array read as []", () => {
    for (const bad of [null, undefined, {}, { lessons: "x" }, { lessons: 3 }]) {
      expect(readStageLessons(bad)).toEqual([]);
    }
  });

  it("drops non-strings, blanks and case-insensitive duplicates", () => {
    expect(
      readStageLessons({
        lessons: [
          "Run tsc first",
          7,
          "   ",
          null,
          "run TSC first",
          "Name the file",
        ],
      })
    ).toEqual(["Run tsc first", "Name the file"]);
  });

  it("caps the list and each line", () => {
    const long = "x".repeat(STAGE_LESSON_MAX_CHARS + 50);
    const out = readStageLessons({
      lessons: [long, "a", "b", "c", "d", "e", "f"],
    });
    expect(out).toHaveLength(MAX_STAGE_LESSONS);
    expect(out[0]).toHaveLength(STAGE_LESSON_MAX_CHARS);
  });
});
