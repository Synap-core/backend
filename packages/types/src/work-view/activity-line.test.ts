/**
 * activityLine on REAL-SHAPED reads: a `GET /timeline?sessionId=` wire (the
 * `DevTimelineEvent` union, newest first) and `activity.list` rows, content
 * invented. Asserted through what each density SHOWS.
 */
import { describe, expect, it } from "vitest";

import type { ActivityActor, ActivityRow } from "../activity/index.js";
import type { DevTimelineEvent, TimelineWire } from "../units/timeline.js";
import type { TrackHistoryEvent } from "../units/track-history.js";
import { ACTIVITY_SUMMARY_MILESTONES, activityLine } from "./activity-line.js";

const AGENT: ActivityActor = { kind: "agent", id: "a1", name: "Claude Code" };
const YOU: ActivityActor = {
  kind: "human",
  id: "u1",
  name: "Founder",
  isViewer: true,
};
const SYSTEM: ActivityActor = { kind: "system", id: null, name: null };

let t = Date.parse("2026-11-16T20:00:00.000Z");
const at = () => new Date((t -= 60_000)).toISOString();

/** Newest first, as the wire: build oldest-last by calling in newest-first order. */
function session(events: DevTimelineEvent[], truncated = false): TimelineWire {
  return {
    subject: { kind: "session", id: "s1", title: "Job" },
    events,
    truncated,
  };
}

const asked = (slot: string): DevTimelineEvent => ({
  id: `history:ask-${slot}-${t}`,
  kind: "slot_asked",
  at: at(),
  actor: AGENT,
  refs: { sessionId: "s1", slotLabel: slot },
  slot,
  askMode: "confirm",
  blockedReason: "decision",
});
const answered = (slot: string): DevTimelineEvent => ({
  id: `history:answer-${slot}-${t}`,
  kind: "slot_answered",
  at: at(),
  actor: YOU,
  refs: { sessionId: "s1", slotLabel: slot },
  slot,
  answerType: "confirm",
  handedBack: true,
  relayed: false,
});
const merged = (n: number): DevTimelineEvent => ({
  id: `event:pr-${n}`,
  kind: "pr_merged",
  at: at(),
  actor: SYSTEM,
  refs: { url: `https://github.com/o/r/pull/${n}` },
  pr: {
    repo: "o/r",
    number: n,
    url: `https://github.com/o/r/pull/${n}`,
    title: null,
  },
  intoDefault: true,
});
const ci = (result: "passed" | "failed"): DevTimelineEvent => ({
  id: `event:ci-${t}`,
  kind: "checks_finished",
  at: at(),
  actor: SYSTEM,
  refs: {},
  checks: {
    repo: "o/r",
    sha: "abc",
    result,
    status: result === "passed" ? "success" : "failure",
    pr: 1,
    job: null,
    workflow: "CI",
  },
});
const paused = (): DevTimelineEvent => ({
  id: `transition:${t}`,
  kind: "status_moved",
  at: at(),
  actor: AGENT,
  refs: { sessionId: "s1" },
  from: "active",
  to: "paused",
  category: "paused",
  reason: "waits on the founder",
  hold: null,
});

function run(outcome: ActivityRow["outcome"], id = `r${t}`): ActivityRow {
  return {
    id: `run:${id}`,
    source: "run",
    occurredAt: at(),
    actor: SYSTEM,
    action: "run",
    verb: "Ran",
    title: "Daily ingest",
    object: { kind: "run", id, name: "Daily ingest", flowType: "automation" },
    proposalId: null,
    project: null,
    session: { id: "s1", title: "Job" },
    outcome,
    undo: null,
    error: outcome === "failed" ? "boom" : null,
  };
}

describe("activityLine", () => {
  it("pins the open ask at Now, and an answered ask is history", () => {
    // Newest first: B asked (open), A answered, A asked.
    const askB = asked("B");
    const ansA = answered("A");
    const askA = asked("A");
    const line = activityLine(session([askB, ansA, askA]), [], "milestones");
    expect(line.now?.key).toBe(`timeline:${askB.id}`);
    expect(line.entries.map((e) => e.key)).toEqual([
      `timeline:${ansA.id}`,
      `timeline:${askA.id}`,
    ]);
    expect(line.entries.every((e) => e.weight === "milestone")).toBe(true);
  });

  it("draws an ask asked twice once, at its latest", () => {
    const again = asked("A");
    const first = asked("A");
    const line = activityLine(session([again, first]), [], "trace");
    expect(line.now?.key).toBe(`timeline:${again.id}`);
    expect(line.entries).toHaveLength(0);
  });

  it("keeps automation runs and passing CI out of Milestones, in Trace", () => {
    const events = [merged(3), ci("passed"), paused()];
    const rows = [run("succeeded"), run("succeeded")];
    const ms = activityLine(session(events), rows, "milestones");
    expect(ms.entries.map((e) => e.kind)).toEqual([
      "pr_merged",
      "status_moved",
    ]);
    expect(ms.hidden.trace).toBe(3);
    const trace = activityLine(session(events), rows, "trace");
    expect(trace.entries).toHaveLength(5);
    expect(trace.hidden).toEqual({ ask: 0, milestone: 0, trace: 0 });
  });

  it("lifts a failed run and a failed CI run into Milestones", () => {
    const line = activityLine(
      session([ci("failed")]),
      [run("failed"), run("succeeded")],
      "milestones"
    );
    expect(line.entries.filter((e) => e.failed)).toHaveLength(2);
    expect(line.entries.every((e) => e.failed)).toBe(true);
  });

  it("Summary: the ask at Now, at most 5 milestones, and a recap of the rest", () => {
    const events: DevTimelineEvent[] = [asked("Now")];
    for (let i = 0; i < 8; i++) events.push(merged(i));
    events.push(ci("passed"));
    const line = activityLine(session(events), [], "summary");
    expect(line.now?.kind).toBe("slot_asked");
    expect(line.entries).toHaveLength(ACTIVITY_SUMMARY_MILESTONES);
    expect(line.hidden).toEqual({ ask: 0, milestone: 3, trace: 1 });
    // Newest first.
    const times = line.entries.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("draws a decision both sources report once, from the timeline", () => {
    const decided: DevTimelineEvent = {
      id: "proposal:p1:answered",
      kind: "decision_answered",
      at: at(),
      actor: YOU,
      refs: { proposalId: "p1" },
      title: "Create task",
      decision: "approved",
      note: null,
    };
    const row: ActivityRow = {
      ...run("succeeded", "p1"),
      source: "decision",
      proposalId: "p1",
      actor: YOU,
    };
    const line = activityLine(session([decided]), [row], "trace");
    expect(line.entries.map((e) => e.source)).toEqual(["timeline"]);
  });

  it("reads a goal's history too: a held check is a failed milestone", () => {
    const held: TrackHistoryEvent = {
      id: "h1",
      kind: "check_held",
      at: at(),
      actor: SYSTEM,
      stageKey: "build",
      refs: {},
      fromStage: "plan",
      failing: ["typecheck"],
      reason: null,
    };
    const goal: TimelineWire = {
      subject: { kind: "goal", id: "g1" },
      events: [held],
      truncated: true,
    };
    const line = activityLine(goal, [], "summary");
    expect(line.entries[0]?.failed).toBe(true);
    expect(line.truncated).toBe(true);
  });
});

describe("activityLine: asks, order and failed reads", () => {
  it("gives an ask back at Now when the person corrects a relayed answer", () => {
    const corrected: DevTimelineEvent = {
      id: "history:corrected",
      kind: "relay_corrected",
      at: at(),
      actor: YOU,
      refs: { sessionId: "s1" },
      slot: "pick",
    };
    const relayed: DevTimelineEvent = { ...answered("pick"), relayed: true };
    const ask = asked("pick");
    const line = activityLine(
      session([corrected, relayed, ask]),
      [],
      "summary"
    );
    expect(line.now?.key).toBe(`timeline:${ask.id}`);
  });

  it("pins the NEWEST open ask; Summary counts the other in the fold, never draws it", () => {
    const newer = asked("b");
    const older = asked("a");
    const line = activityLine(session([newer, older]), [], "summary");
    expect(line.now?.key).toBe(`timeline:${newer.id}`);
    expect(line.entries).toEqual([]);
    expect(line.hidden.ask).toBe(1);
  });

  it("keeps the pod's order on equal times", () => {
    const same = "2026-11-16T10:00:00.000Z";
    const m: DevTimelineEvent = {
      ...merged(7),
      id: "event:a-merged",
      at: same,
    };
    const o: DevTimelineEvent = {
      ...merged(7),
      id: "event:z-opened",
      kind: "pr_opened",
      intoDefault: null,
      at: same,
    };
    // The wire says merged (newer) before opened; ids sort the other way.
    expect(
      activityLine(session([m, o]), [], "trace").entries.map((e) => e.kind)
    ).toEqual(["pr_merged", "pr_opened"]);
    expect(
      activityLine(session([o, m]), [], "trace").entries.map((e) => e.kind)
    ).toEqual(["pr_opened", "pr_merged"]);
  });

  it("says when the Activity read failed, unlike an empty one", () => {
    expect(
      activityLine(session([merged(1)]), null, "trace").unavailable
    ).toEqual(["activity"]);
    expect(activityLine(session([merged(1)]), [], "trace").unavailable).toEqual(
      []
    );
  });
});
