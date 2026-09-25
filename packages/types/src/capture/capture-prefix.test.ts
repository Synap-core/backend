/**
 * The capture-prefix grammar, tested where plausible rewrites DISAGREE (case,
 * leading whitespace, one-char input, a prefix glued to a word, a doubled
 * bang) — the same table relay/desktop's parity tripwire used to run through
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
  ["/capture call Ana", true, "call Ana"],
  ["/capturecall Ana", true, "call Ana"], // prefix glued to the word
  ["/Capture call Ana", false, "call Ana"], // detection is case-sensitive, strip is not
  ["!!double", true, "!double"], // one bang stripped, not all
  ["!", false, ""], // too short to be a capture
  ["  !x", true, "  !x"], // detect trims; strip does not
  ["buy milk", false, "buy milk"],
  ["what did Ana say?", false, "what did Ana say?"],
  ["a!b", false, "a!b"],
];

describe("capture-prefix grammar", () => {
  it("answers every row correctly", () => {
    for (const [input, isCapture, stripped] of TABLE) {
      expect([input, isExplicitCapturePrefix(input)]).toEqual([
        input,
        isCapture,
      ]);
      expect([input, stripCapturePrefix(input)]).toEqual([input, stripped]);
    }
  });
});
