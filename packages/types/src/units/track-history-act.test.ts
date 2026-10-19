/**
 * ONE event → ONE line, for both surfaces (U5): what the line says, where it
 * opens, how it stands. Relay and the browser had each written this and
 * disagreed; these rows pin the answers where they disagreed (decision_asked's
 * outcome, a step move's words, a status move's verb, the session count).
 */
import { describe, expect, it } from "vitest";
import type { ActivityActor } from "../activity/index.js";
import { CHECK_GATE_UNEVALUATED } from "../focus-sessions/check-gate.js";
import {
  TRACK_STEP_DOOR_KIND,
  checkFailingLabels,
  trackHistoryAct,
  trackHistoryNote,
  trackHistorySummaryWords,
  trackStepMover,
  type TrackHistoryEvent,
} from "./track-history.js";

const me: ActivityActor = {
  kind: "human",
  id: "u1",
  name: "Ana",
  isViewer: true,
};
const ctx = {
  trackId: "t1",
  trackName: "Launch",
  stages: [
    { key: "frame", name: "Frame" },
    { key: "shape", name: "Shape" },
  ],
};
const ev = (rest: Record<string, unknown>): TrackHistoryEvent =>
  ({
    id: "e",
    at: "2026-10-11T10:00:00.000Z",
    actor: me,
    stageKey: "shape",
    refs: {},
    ...rest,
  }) as TrackHistoryEvent;

describe("trackHistoryAct", () => {
  it("a step move opens the step ENTERED (a step door, the stage key as id)", () => {
    expect(
      trackHistoryAct(ev({ kind: "step_moved", fromStage: "frame" }), ctx)
    ).toEqual({
      action: "move",
      title: "to Shape",
      door: { kind: TRACK_STEP_DOOR_KIND, id: "shape" },
      outcome: "succeeded",
    });
  });

  it("an open ask WAITS on a person and opens its proposal, else the session it was filed in", () => {
    const a = trackHistoryAct(
      ev({
        kind: "decision_asked",
        title: "Publish",
        refs: { proposalId: "p1", sessionId: "s1" },
      }),
      ctx
    );
    expect(a).toMatchObject({
      action: "ask",
      outcome: "waiting",
      door: { kind: "proposal", id: "p1" },
    });
    const b = trackHistoryAct(
      ev({ kind: "decision_asked", title: null, refs: { sessionId: "s1" } }),
      ctx
    );
    expect(b.door).toEqual({ kind: "session", id: "s1" });
  });

  it("answers: rejected / reverted / a failed approval wear their own outcome", () => {
    const ans = (decision: string) =>
      trackHistoryAct(
        ev({ kind: "decision_answered", title: "X", decision, note: null }),
        ctx
      );
    expect(ans("approved")).toMatchObject({
      action: "approve",
      outcome: "succeeded",
    });
    expect(ans("rejected")).toMatchObject({
      action: "reject",
      outcome: "rejected",
    });
    expect(ans("reverted")).toMatchObject({
      action: "revert",
      outcome: "reverted",
    });
    expect(ans("approval_failed")).toMatchObject({
      action: "approve",
      outcome: "failed",
    });
  });

  it("a closed session graded failing did not succeed; a cancelled one stopped", () => {
    const closed = (sessionStatus: string, verdict: string) =>
      trackHistoryAct(
        ev({
          kind: "session_closed",
          title: "D",
          sessionStatus,
          verdict,
          refs: { sessionId: "s1" },
        }),
        ctx
      );
    expect(closed("closed", "failing").outcome).toBe("failed");
    expect(closed("closed", "passing").outcome).toBe("succeeded");
    expect(closed("cancelled", "none").outcome).toBe("stopped");
    expect(closed("closed", "passing").door).toEqual({
      kind: "session",
      id: "s1",
    });
  });

  it("a held check FAILED and opens the step it measured", () => {
    expect(
      trackHistoryAct(
        ev({
          kind: "check_held",
          fromStage: "frame",
          failing: [],
          reason: null,
        }),
        ctx
      )
    ).toEqual({
      action: "check",
      title: "Frame",
      door: { kind: TRACK_STEP_DOOR_KIND, id: "frame" },
      outcome: "failed",
    });
  });

  it("a status move's verb is the shared transition table's", () => {
    expect(
      trackHistoryAct(
        ev({
          kind: "status_changed",
          fromStatus: "active",
          toStatus: "completed",
        }),
        ctx
      ).action
    ).toBe("complete");
    expect(
      trackHistoryAct(
        ev({
          kind: "status_changed",
          fromStatus: "completed",
          toStatus: "active",
        }),
        ctx
      ).action
    ).toBe("reopen");
  });

  it("a step the track no longer declares reads as its key, humanized", () => {
    expect(
      trackHistoryAct(
        ev({ kind: "step_moved", stageKey: "old_step", fromStage: null }),
        ctx
      ).title
    ).toBe("to Old step");
  });
});

describe("trackHistorySummaryWords", () => {
  it("counts; a session that starts and closes in a step is ONE session", () => {
    expect(
      trackHistorySummaryWords({
        moves: 2,
        sessionsStarted: 1,
        sessionsClosed: 1,
        decisions: 1,
        openAsks: 0,
        failures: 0,
      })
    ).toBe("1 session · 1 decision · Moved ×2");
    expect(
      trackHistorySummaryWords({
        moves: 0,
        sessionsStarted: 0,
        sessionsClosed: 0,
        decisions: 0,
        openAsks: 0,
        failures: 0,
      })
    ).toBe("");
  });
});

describe("checkFailingLabels / trackHistoryNote", () => {
  const stages = [
    {
      key: "frame",
      criteria: [{ key: "tone", statement: "Tone is on brand" }],
    },
  ];
  it("a criterion reads as its statement; the unevaluated marker and unknown keys still read", () => {
    expect(
      checkFailingLabels(
        ["tone", CHECK_GATE_UNEVALUATED, "word_count"],
        stages[0]
      )
    ).toEqual([
      "Tone is on brand",
      "The check could not measure this step",
      "Word count",
    ]);
  });
  it("a held check carries its why; a note-less answer carries nothing", () => {
    expect(
      trackHistoryNote(
        ev({
          kind: "check_held",
          fromStage: "frame",
          failing: ["tone"],
          reason: "Off",
        }),
        stages
      )
    ).toEqual({
      reason: "Off",
      failing: ["Tone is on brand"],
    });
    expect(
      trackHistoryNote(
        ev({
          kind: "decision_answered",
          title: null,
          decision: "approved",
          note: null,
        }),
        stages
      )
    ).toBeNull();
  });
});

describe("trackStepMover", () => {
  const nova: ActivityActor = { kind: "agent", id: "a1", name: "Nova" };
  const history = [
    { stageKey: "shape", enteredAt: "2026-10-01T00:00:00.000Z", enteredBy: me },
    {
      stageKey: "shape",
      enteredAt: "2026-10-05T00:00:00.000Z",
      enteredBy: nova,
    },
  ];
  it("names the mover of THE entry the card read (same step, same instant), never another", () => {
    expect(
      trackStepMover(history, {
        key: "shape",
        enteredBy: { at: "2026-10-01T00:00:00.000Z" },
      })
    ).toEqual(me);
    expect(
      trackStepMover(history, {
        key: "shape",
        enteredBy: { at: "2026-10-05T00:00:00.000Z" },
      })
    ).toEqual(nova);
    expect(
      trackStepMover(history, {
        key: "frame",
        enteredBy: { at: "2026-10-05T00:00:00.000Z" },
      })
    ).toBeUndefined();
    expect(trackStepMover(history, null)).toBeUndefined();
  });
});
