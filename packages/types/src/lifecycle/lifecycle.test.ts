import { describe, it, expect } from "vitest";
import {
  lifecycleOptionLabel,
  lifecycleOptionTone,
  isTerminalLifecycleCategory,
  LIFECYCLE_CATEGORIES,
} from "./index.js";

describe("lifecycle (types)", () => {
  it("labels: authored label wins, else the shared vocabulary", () => {
    expect(lifecycleOptionLabel({ key: "won", label: "Closed won" })).toBe(
      "Closed won"
    );
    // falls through to resolveStatusLabel → humanizeToken, never a raw token
    expect(lifecycleOptionLabel({ key: "in_review" })).not.toBe("in_review");
    expect(lifecycleOptionLabel({ key: "negotiating" }).length).toBeGreaterThan(
      0
    );
  });

  it("tones: an authored real token wins, else the category default", () => {
    expect(lifecycleOptionTone({ category: "done" })).toBe("success");
    expect(lifecycleOptionTone({ category: "lost" })).toBe("error");
    expect(lifecycleOptionTone({ category: "paused" })).toBe("warning");
    expect(lifecycleOptionTone({ category: "active", tone: "ai" })).toBe("ai");
    expect(lifecycleOptionTone({ category: "active", tone: "#ff0000" })).toBe(
      "primary"
    );
  });

  it("every category has a tone; only done/lost are terminal", () => {
    for (const c of LIFECYCLE_CATEGORIES) {
      expect(lifecycleOptionTone({ category: c })).toBeTruthy();
    }
    expect(LIFECYCLE_CATEGORIES.filter(isTerminalLifecycleCategory)).toEqual([
      "done",
      "lost",
    ]);
  });
});
