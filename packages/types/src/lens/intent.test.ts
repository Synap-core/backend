/**
 * The intent surface's header model. Rows chosen where naive rules disagree:
 * a READ zero (a naive "always show the four counts" rule keeps its door),
 * an unknown count (a naive `?? 0` drops it and says All clear), a 30-day
 * window (a naive rule always says "this week").
 */
import { describe, expect, it } from "vitest";
import {
  LENS_INTENT_SECTION_LABELS,
  lensIntentHeaderModel,
  lensIntentDoorText,
} from "./intent.js";
import { LENS_SCOPE_FACT_KIND, lensKpiFact } from "./header.js";
import {
  encodeLensScope,
  lensActivityScope,
  lensScopeObject,
  parseLensScope,
  visibleSource,
} from "./scope.js";

const counts = {
  needsYou: 3,
  beingWorked: 2,
  live: 15,
  doneWindowed: 1,
  windowDays: 7,
};

describe("lensIntentHeaderModel", () => {
  it("says the four counts once, in order, each a door", () => {
    const m = lensIntentHeaderModel({ counts });
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
      counts: { ...counts, needsYou: 0, beingWorked: 0 },
    });
    expect(m.doors.map((d) => d.section)).toEqual(["pipeline", "produced"]);
    expect(m.allClear).toBe(true);
  });

  it("an UNKNOWN needs-you reads as unknown (\u2013), never a bare label, never All clear", () => {
    const m = lensIntentHeaderModel({
      counts: { ...counts, needsYou: null },
    });
    expect(m.doors[0]).toMatchObject({
      section: "blocking",
      count: null,
      text: "\u2013 need you",
    });
    // Every intent door says unknown the same way (WP.7).
    expect(lensIntentDoorText("happening", null)).toBe("\u2013 being worked");
    expect(lensIntentDoorText("pipeline", null)).toBe("\u2013 in pipeline");
    expect(lensIntentDoorText("produced", null, 30)).toBe(
      "\u2013 done in the last 30 days"
    );
    expect(m.allClear).toBe(false);
    // a live agent outranks the unknown (the shared order); without one, unmeasured
    expect(m.state.state).toBe("working");
    const quiet = lensIntentHeaderModel({
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
    const m = lensIntentHeaderModel({ counts, goal });
    expect(m.fact).toEqual(goal);
  });
});

describe("the pipeline lens scope", () => {
  it("the header is a pipeline header (it carries the kind's goal and a pulse)", () => {
    expect(lensIntentHeaderModel({ counts }).scopeKind).toBe("pipeline");
    expect(LENS_SCOPE_FACT_KIND.pipeline).toBe("kpi");
  });

  it("travels in ONE address token with its narrowest container", () => {
    const cases = [
      { kind: "pipeline", profileSlug: "post" },
      { kind: "pipeline", profileSlug: "post", projectId: "p1" },
      { kind: "pipeline", profileSlug: "lead", trackId: "t1" },
      { kind: "pipeline", profileSlug: "deal", workspaceId: "w1" },
    ] as const;
    expect(cases.map(encodeLensScope)).toEqual([
      "pipeline:post",
      "pipeline:post@project:p1",
      "pipeline:lead@track:t1",
      "pipeline:deal@workspace:w1",
    ]);
    for (const c of cases)
      expect(parseLensScope(encodeLensScope(c))).toEqual(c);
    // the other kinds still read through the activity door
    expect(parseLensScope("project:p1")).toEqual({
      kind: "project",
      projectId: "p1",
    });
    expect(parseLensScope("pipeline:")).toBeUndefined();
    expect(parseLensScope("pipeline:post@session:s1")).toBeUndefined();
  });

  it("a source the pipeline sits INSIDE is hidden; a more specific one shows", () => {
    const scope = {
      kind: "pipeline",
      profileSlug: "post",
      projectId: "p1",
    } as const;
    expect(lensScopeObject(scope)).toEqual({ kind: "pipeline", id: "post" });
    const row = (source: { kind: "project" | "session"; id: string }) => ({
      source: { ...source, label: "x" },
    });
    expect(visibleSource(row({ kind: "project", id: "p1" }), scope)).toBeNull();
    expect(
      visibleSource(row({ kind: "session", id: "s1" }), scope)
    ).not.toBeNull();
  });

  it("reads activity at its container (never a kind's own heat)", () => {
    expect(
      lensActivityScope({
        kind: "pipeline",
        profileSlug: "post",
        projectId: "p1",
      })
    ).toEqual({ kind: "project", projectId: "p1" });
    expect(
      lensActivityScope({ kind: "pipeline", profileSlug: "post" })
    ).toEqual({ kind: "pod" });
    expect(
      lensActivityScope({
        kind: "workspace",
        workspaceId: "w1",
        projectId: "p1",
      })
    ).toEqual({ kind: "workspace", workspaceId: "w1" });
  });
});

describe("LENS_INTENT_SECTION_LABELS", () => {
  it("one spelling for the surface's sections, desktop and phone", () => {
    expect(LENS_INTENT_SECTION_LABELS).toEqual({
      blocking: "Needs you",
      happening: "Working now",
      workers: "Workers",
    });
  });
});
