import { describe, expect, it } from "vitest";
import {
  deriveTrackStages,
  readTrackDirection,
  readTrackKpi,
  trackKpiJustReached,
  trackKpiReached,
  trackStagesEmerged,
} from "./track.js";
import { unmetRequiredOutcomes } from "./outcome.js";

describe("readTrackKpi", () => {
  it("needs a label and a finite target", () => {
    expect(readTrackKpi(null)).toBeNull();
    expect(readTrackKpi({ label: "Leads" })).toBeNull();
    expect(readTrackKpi({ label: "", target: 3 })).toBeNull();
    expect(readTrackKpi({ label: "Leads", target: Number.NaN })).toBeNull();
    expect(readTrackKpi({ label: " Leads ", target: 3, current: "4" })).toEqual(
      { label: "Leads", target: 3 }
    );
  });
});

describe("trackKpiJustReached — nudges on the CROSSING only", () => {
  const before = { label: "L", target: 10, current: 8 };
  it("crossing ⇒ true", () => {
    expect(trackKpiJustReached(before, { ...before, current: 10 })).toBe(true);
  });
  it("already reached ⇒ false (rival: 'reached after' alone re-nudges)", () => {
    expect(trackKpiReached({ ...before, current: 11 })).toBe(true);
    expect(
      trackKpiJustReached(
        { ...before, current: 11 },
        { ...before, current: 12 }
      )
    ).toBe(false);
  });
  it("lowering the target under a stated value is a crossing too", () => {
    expect(trackKpiJustReached(before, { ...before, target: 8 })).toBe(true);
  });
  it("no current ⇒ never reached", () => {
    expect(trackKpiJustReached(null, { label: "L", target: 0 })).toBe(false);
  });
});

describe("emergent stages", () => {
  it("addedAt is read through, and marks emergence", () => {
    const stages = deriveTrackStages(
      [
        { key: "a", name: "A" },
        { key: "b", name: "B", addedAt: "2026-10-05T10:00:00Z" },
      ],
      "a"
    );
    expect(stages[1]!.addedAt).toBe("2026-10-05T10:00:00Z");
    expect(trackStagesEmerged(stages)).toBe(true);
    expect(trackStagesEmerged(stages.slice(0, 1))).toBe(false);
  });
  it("direction is trimmed or null", () => {
    expect(readTrackDirection("  Be the reference ")).toBe("Be the reference");
    expect(readTrackDirection("   ")).toBeNull();
  });
});

describe("unmetRequiredOutcomes", () => {
  it("required, not retired, not met — nothing else", () => {
    expect(
      unmetRequiredOutcomes([
        { key: "a", required: true, met: false, retired: false },
        { key: "b", required: false, met: false, retired: false },
        { key: "c", required: true, met: true, retired: false },
        { key: "d", required: true, met: false, retired: true },
      ])
    ).toEqual(["a"]);
  });
});
