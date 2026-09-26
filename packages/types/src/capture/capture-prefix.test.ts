/**
 * The capture-prefix grammar, tested where plausible rewrites DISAGREE (case,
 * leading whitespace, a bare marker, a prefix glued to a word, a doubled
 * bang, a trailing bang) — the same table relay/desktop's parity tripwire used to run through
 * two mirrored copies, now run once against the single shared implementation.
 */
import { describe, expect, it } from "vitest";
import {
  isExplicitCapturePrefix,
  stripCapturePrefix,
} from "./capture-prefix.js";

/** [input, is an explicit capture, stripped text] */
const TABLE: ReadonlyArray<readonly [string, boolean, string]> = [
  ["!buy milk", true, "buy milk"],
  ["! buy milk", true, "buy milk"],
  ["!x", true, "x"],
  ["! x", true, "x"],
  ["x!", false, "x!"], // the bang must LEAD
  ["/capture call Ana", true, "call Ana"],
  ["/capture\tcall Ana", true, "call Ana"], // any whitespace ends the word
  // `/capture` is a WHOLE word: a longer word sharing the prefix is not a
  // capture, and strip must leave it intact (it used to yield "d notes").
  ["/captured notes", false, "/captured notes"],
  ["/capturecall Ana", false, "/capturecall Ana"],
  // Case-insensitive for BOTH detect and strip (detect used to be case-sensitive).
  ["/Capture x", true, "x"],
  ["/CAPTURE call Ana", true, "call Ana"],
  // A marker with nothing after it is not a capture yet — both markers alike.
  ["/capture", false, ""],
  ["/capture   ", false, ""],
  ["!", false, ""],
  ["!   ", false, ""],
  ["!!double", true, "!double"], // one marker stripped, not all
  ["/capture !x", true, "!x"], // one marker stripped, not both
  ["  !x", true, "x"], // detect and strip share one rule: both skip leading space
  ["buy milk", false, "buy milk"],
  ["what did Ana say?", false, "what did Ana say?"],
  ["a!b", false, "a!b"],
  ["", false, ""],
];

describe("capture-prefix grammar", () => {
  it.each(TABLE)(
    "%j → capture=%s, stripped=%j",
    (input, isCapture, stripped) => {
      expect(isExplicitCapturePrefix(input)).toBe(isCapture);
      expect(stripCapturePrefix(input)).toBe(stripped);
    }
  );
});
