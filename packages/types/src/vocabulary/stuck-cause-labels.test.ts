import { describe, expect, it } from "vitest";
import { STUCK_CAUSE_ORDER } from "../units/stuck.js";
import { resolveStuckCauseLabel, STUCK_CAUSE_LABELS } from "./index.js";

describe("stuck cause labels", () => {
  it("words every cause once, and nothing else", () => {
    expect(Object.keys(STUCK_CAUSE_LABELS).sort()).toEqual(
      [...STUCK_CAUSE_ORDER].sort()
    );
    const words = STUCK_CAUSE_ORDER.map(resolveStuckCauseLabel);
    expect(new Set(words).size).toBe(words.length);
    expect(resolveStuckCauseLabel("gone_quiet")).toBe("Gone quiet");
  });
});
