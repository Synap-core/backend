/**
 * The intent surface's header model. Rows chosen where naive rules disagree:
 * a READ zero (a naive "always show the four counts" rule keeps its door),
 * an unknown count (a naive `?? 0` drops it and says All clear), a 30-day
 * window (a naive rule always says "this week").
 */
import { describe, expect, it } from "vitest";
import { lensIntentHeaderModel, lensIntentDoorText } from "./intent.js";
import { lensKpiFact } from "./header.js";

const counts = {
  needsYou: 3,
  beingWorked: 2,
  live: 15,
  doneWindowed: 1,
  windowDays: 7,
};

describe("lensIntentHeaderModel", () => {
  it("says the four counts once, in order, each a door", () => {
    const m = lensIntentHeaderModel({ scopeKind: "workspace", counts });
    expect(m.doors.map((d) => d.text)).toEqual([
      "3 need you",
      "2 being worked",
      "15 in pipeline",
      "1 done this week",
    ]);
    expect(m.doors.map((d) => d.section)).toEqual([
      "blocking",
      "happening",
      "pipeline",
      "produced",
    ]);
    expect(m.state.state).toBe("needs_you");
    expect(m.allClear).toBe(false);
  });

  it("a READ zero omits its door; nobody waiting is All clear", () => {
    const m = lensIntentHeaderModel({
      scopeKind: "project",
      counts: { ...counts, needsYou: 0, beingWorked: 0 },
    });
    expect(m.doors.map((d) => d.section)).toEqual(["pipeline", "produced"]);
    expect(m.allClear).toBe(true);
  });

  it("an UNKNOWN needs-you keeps its door wordless and is never All clear", () => {
    const m = lensIntentHeaderModel({
      scopeKind: "track",
      counts: { ...counts, needsYou: null },
    });
    expect(m.doors[0]).toMatchObject({
      section: "blocking",
      count: null,
      text: "Needs you",
    });
    expect(m.allClear).toBe(false);
    // a live agent outranks the unknown (the shared order); without one, unmeasured
    expect(m.state.state).toBe("working");
    const quiet = lensIntentHeaderModel({
      scopeKind: "track",
      counts: { ...counts, needsYou: null, beingWorked: 0 },
    });
    expect(quiet.state.state).toBe("unmeasured");
  });

  it("the done window is said as it was read", () => {
    expect(lensIntentDoorText("produced", 4, 30)).toBe(
      "4 done in the last 30 days"
    );
    expect(lensIntentDoorText("produced", 4, 7)).toBe("4 done this week");
  });

  it("the ONE fact is the kind's goal", () => {
    const goal = lensKpiFact({
      label: "Posts per week",
      target: 3,
      current: 1,
      unit: null,
      statedAt: "2026-10-10T00:00:00.000Z",
    });
    const m = lensIntentHeaderModel({ scopeKind: "workspace", counts, goal });
    expect(m.fact).toEqual(goal);
  });
});
