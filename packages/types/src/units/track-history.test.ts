import { describe, expect, it } from "vitest";
import type { ActivityActor } from "../activity/index.js";
import {
  TRACK_HISTORY_GROUP_BY,
  isTrackHistoryFailure,
  trackHistoryGroups,
  type TrackHistoryEvent,
} from "./track-history.js";
import { readTrackCheckGate, readTrackStageHistory } from "./track.js";

const me: ActivityActor = {
  kind: "human",
  id: "u1",
  name: "Ana",
  isViewer: true,
};
const check: ActivityActor = { kind: "system", id: null, name: null };
const stages = [
  { key: "discover", name: "Discover" },
  { key: "build", name: "Build" },
];

const ev = (
  id: string,
  at: string,
  stageKey: string | null,
  rest: Record<string, unknown>
): TrackHistoryEvent =>
  ({ id, at, actor: me, stageKey, refs: {}, ...rest }) as TrackHistoryEvent;

describe("trackHistoryGroups — by step (D4a)", () => {
  it("is THE policy", () => {
    expect(TRACK_HISTORY_GROUP_BY).toBe("step");
  });

  it("newest step first and open; a quiet past step folds", () => {
    const groups = trackHistoryGroups(
      [
        ev("a", "2026-10-01T09:00:00Z", "discover", { kind: "track_started" }),
        ev("b", "2026-10-02T09:00:00Z", "discover", {
          kind: "session_started",
          title: "Interviews",
        }),
        ev("c", "2026-10-05T09:00:00Z", "build", {
          kind: "step_moved",
          fromStage: "discover",
        }),
      ],
      stages
    );
    expect(groups.map((g) => g.key)).toEqual(["step:build", "step:discover"]);
    expect(groups[0]).toMatchObject({
      stage: { key: "build", name: "Build" },
      open: true,
      lastAt: "2026-10-05T09:00:00Z",
      summary: { moves: 1 },
    });
    expect(groups[1]!.open).toBe(false);
    expect(groups[1]!.summary.sessionsStarted).toBe(1);
    // newest first inside a group
    expect(groups[1]!.events.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("a past step holding a failure or an open ask stays open", () => {
    const held = trackHistoryGroups(
      [
        ev("x", "2026-10-01T09:00:00Z", "discover", {
          kind: "check_held",
          fromStage: "discover",
          failing: ["k"],
          reason: null,
          actor: check,
        }),
        ev("y", "2026-10-03T09:00:00Z", "build", { kind: "paused" }),
      ],
      stages
    );
    expect(held.find((g) => g.key === "step:discover")!.open).toBe(true);
    expect(held.find((g) => g.key === "step:discover")!.summary.failures).toBe(
      1
    );

    const asked = trackHistoryGroups(
      [
        ev("p", "2026-10-01T09:00:00Z", "discover", {
          kind: "decision_asked",
          title: null,
        }),
        ev("q", "2026-10-03T09:00:00Z", "build", { kind: "resumed" }),
      ],
      stages
    );
    expect(asked[1]).toMatchObject({ open: true, summary: { openAsks: 1 } });
  });

  it("a re-entered step is ONE group, and an undeclared step is listed under its humanized key", () => {
    const groups = trackHistoryGroups(
      [
        ev("1", "2026-10-01T09:00:00Z", "discover", {
          kind: "step_moved",
          fromStage: null,
        }),
        ev("2", "2026-10-02T09:00:00Z", "build", {
          kind: "step_moved",
          fromStage: "discover",
        }),
        ev("3", "2026-10-03T09:00:00Z", "discover", {
          kind: "step_moved",
          fromStage: "build",
        }),
        ev("4", "2026-10-04T09:00:00Z", "old_step", { kind: "resumed" }),
        ev("5", "2026-09-01T09:00:00Z", null, { kind: "track_started" }),
      ],
      stages
    );
    expect(groups.map((g) => g.key)).toEqual([
      "step:old_step",
      "step:discover",
      "step:build",
      "step:",
    ]);
    expect(groups[0]!.stage).toEqual({ key: "old_step", name: "Old step" });
    expect(groups[1]!.events).toHaveLength(2);
    expect(groups[3]!.stage).toBeNull();
  });
});

describe("trackHistoryGroups — by day (D4b is one word)", () => {
  it("groups by the viewer's calendar day", () => {
    const groups = trackHistoryGroups(
      [
        ev("a", "2026-10-01T23:30:00Z", "discover", { kind: "paused" }),
        ev("b", "2026-10-02T00:30:00Z", "build", { kind: "resumed" }),
      ],
      stages,
      { by: "day", timeZone: "UTC" }
    );
    expect(groups.map((g) => g.key)).toEqual([
      "day:2026-10-02",
      "day:2026-10-01",
    ]);
    expect(groups[0]).toMatchObject({
      by: "day",
      stage: null,
      day: "2026-10-02",
    });
    // the same instants are one day in Paris (UTC+2)
    expect(
      trackHistoryGroups(
        [
          ev("a", "2026-10-01T23:30:00Z", "discover", { kind: "paused" }),
          ev("b", "2026-10-02T00:30:00Z", "build", { kind: "resumed" }),
        ],
        stages,
        { by: "day", timeZone: "Europe/Paris" }
      ).map((g) => g.key)
    ).toEqual(["day:2026-10-02"]);
  });
});

describe("failure classification", () => {
  it("a failing or failed session, a held check and a failed approval are failures", () => {
    const s = (verdict: string, sessionStatus: string) =>
      ev("s", "2026-10-01T00:00:00Z", null, {
        kind: "session_closed",
        title: "t",
        verdict,
        sessionStatus,
      });
    expect(isTrackHistoryFailure(s("failing", "closed"))).toBe(true);
    expect(isTrackHistoryFailure(s("none", "failed"))).toBe(true);
    expect(isTrackHistoryFailure(s("passing", "closed"))).toBe(false);
    expect(isTrackHistoryFailure(s("incomplete", "closed"))).toBe(false);
    expect(
      isTrackHistoryFailure(
        ev("d", "2026-10-01T00:00:00Z", null, {
          kind: "decision_answered",
          title: null,
          decision: "approval_failed",
          note: null,
        })
      )
    ).toBe(true);
  });
});

describe("track readers U5", () => {
  it("readTrackCheckGate: the marker while paused by it, null otherwise", () => {
    const metadata = {
      checkGate: {
        stageKey: "build",
        fromStage: "discover",
        failing: ["k"],
        reason: "no session closed",
      },
    };
    expect(readTrackCheckGate({ status: "paused", metadata })).toEqual({
      stageKey: "build",
      fromStage: "discover",
      failing: ["k"],
      reason: "no session closed",
    });
    expect(readTrackCheckGate({ status: "active", metadata })).toBeNull();
    expect(readTrackCheckGate({ status: "paused", metadata: {} })).toBeNull();
  });

  it("readTrackStageHistory carries a stamped check verdict", () => {
    const [a, b] = readTrackStageHistory([
      {
        stageKey: "build",
        fromStage: "discover",
        enteredAt: "t",
        actor: "u1",
        check: { passed: false, failing: ["k"], reason: "r" },
      },
      { stageKey: "ship", fromStage: "build", enteredAt: "t2", actor: "u1" },
    ]);
    expect(a!.check).toEqual({ passed: false, failing: ["k"], reason: "r" });
    expect(b).not.toHaveProperty("check");
  });
});
