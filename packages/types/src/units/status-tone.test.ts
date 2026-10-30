import { describe, expect, it } from "vitest";
import {
  isUnitTone,
  LIFECYCLE_CATEGORY_TONE,
  resolveStatusTone,
  STATUS_TONE,
  UNIT_TONES,
} from "./state.js";
import { LIFECYCLE_CATEGORY_TONE as LIFECYCLE_REEXPORT } from "../lifecycle/index.js";

/**
 * THE status tone table (`./state.ts`). The three words the app's two tables
 * disagreed on are the rows that matter: each assertion below rules out one of
 * the two old readings.
 */
describe("the status tone table", () => {
  it("keeps the calm reading where the app's tables disagreed", () => {
    // Rules out property-renderer's red rejected / cancelled and teal draft.
    expect(resolveStatusTone("rejected")).toBe("textMuted");
    expect(resolveStatusTone("cancelled")).toBe("textMuted");
    expect(resolveStatusTone("canceled")).toBe("textMuted");
    expect(resolveStatusTone("draft")).toBe("textMuted");
  });

  it("reads `stale` as `paused`", () => {
    expect(resolveStatusTone("stale")).toBe(resolveStatusTone("paused"));
  });

  it("normalises case, outer space and inner spaces", () => {
    expect(resolveStatusTone("  Done ")).toBe("success");
    expect(resolveStatusTone("In Review")).toBe("info");
    expect(resolveStatusTone("in  progress")).toBe("primary");
  });

  it("an unknown or absent word is muted, never a guessed colour", () => {
    expect(resolveStatusTone("negotiating-hard")).toBe("textMuted");
    expect(resolveStatusTone(null)).toBe("textMuted");
    expect(resolveStatusTone("")).toBe("textMuted");
    // An inherited property is not a row.
    expect(resolveStatusTone("constructor")).toBe("textMuted");
  });

  it("every value is a real tone token, and keys are stored lower case", () => {
    for (const [key, tone] of Object.entries(STATUS_TONE)) {
      expect(isUnitTone(tone)).toBe(true);
      expect(key).toBe(key.trim().toLowerCase());
    }
    expect(Object.keys(STATUS_TONE).length).toBeGreaterThan(50);
  });

  it("isUnitTone accepts exactly the tokens", () => {
    for (const t of UNIT_TONES) expect(isUnitTone(t)).toBe(true);
    expect(isUnitTone("#ff0000")).toBe(false);
    expect(isUnitTone(undefined)).toBe(false);
  });

  it("the lifecycle module re-exports the category tones, not a copy", () => {
    expect(LIFECYCLE_REEXPORT).toBe(LIFECYCLE_CATEGORY_TONE);
  });
});
