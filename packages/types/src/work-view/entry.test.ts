/**
 * entryOf / groupEntries: every expectation is written out (a sameness check
 * against the door it calls would pass on a wrong mapping), and each rule was
 * run with its fix reverted (negative control `negctl/feat/timeline-entry-module`).
 */
import { describe, expect, it } from "vitest";

import {
  activityActorName,
  type ActivityActor,
  type ActivityRow,
} from "../activity/index.js";
import type { DevTimelineEvent } from "../units/timeline.js";
import type { TrackHistoryEvent } from "../units/track-history.js";
import { activityLine } from "./activity-line.js";
import { entryOf, foldChecks, groupEntries, type WorkEntry } from "./entry.js";

const SYSTEM: ActivityActor = { kind: "system", id: null, name: null };
const YOU: ActivityActor = {
  kind: "human",
  id: "u1",
  name: "Antoine",
  isViewer: true,
};

let n = 0;
const at = (min: number) =>
  new Date(Date.UTC(2026, 10, 17, 12, 0) + min * 60_000).toISOString();

const opened = (num: number, min: number): DevTimelineEvent => ({
  id: `event:open-${num}-${n++}`,
  kind: "pr_opened",
  at: at(min),
  actor: SYSTEM,
  refs: { url: `https://github.com/o/r/pull/${num}` },
  pr: { repo: "o/r", number: num, url: `u${num}`, title: null },
  intoDefault: null,
});
const merged = (num: number, min: number): DevTimelineEvent => ({
  ...opened(num, min),
  kind: "pr_merged",
  intoDefault: true,
});
const check = (
  pr: number | null,
  min: number,
  result: "passed" | "failed" | null = "passed"
): DevTimelineEvent => ({
  id: `event:ci-${n++}`,
  kind: "checks_finished",
  at: at(min),
  actor: SYSTEM,
  refs: {},
  checks: {
    repo: "o/r",
    sha: "abc1234",
    result,
    status: result === "failed" ? "failure" : "success",
    pr,
    job: null,
    workflow: "CI",
  },
});
const answered = (min: number): DevTimelineEvent => ({
  id: `history:answer-${n++}`,
  kind: "slot_answered",
  at: at(min),
  actor: YOU,
  refs: { sessionId: "s1", slotLabel: "Pick" },
  slot: "Pick",
  answerType: "confirm",
  handedBack: true,
  relayed: false,
});
const started = (min: number): DevTimelineEvent => ({
  id: `session:s1:start`,
  kind: "session_started",
  at: at(min),
  actor: YOU,
  refs: { sessionId: "s1" },
  title: "Ship it",
});

function entries(
  events: DevTimelineEvent[],
  ctx = { jobId: "s1" }
): WorkEntry[] {
  // newest first, as the wire is
  const sorted = [...events].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at)
  );
  return activityLine(
    { events: sorted, truncated: false },
    [],
    "trace"
  ).entries.map((l) => entryOf(l, ctx));
}

describe("entryOf: one display entry", () => {
  it("a merged pull request: who, when, the past verb, the words, the pull request, the url", () => {
    const [e] = entries([merged(7, 5)]);
    expect(e).toMatchObject({
      kind: "pr_merged",
      at: at(5),
      who: activityActorName(SYSTEM),
      action: "merge",
      verb: "Merged",
      text: "Merged o/r#7",
      pr: { repo: "o/r", number: 7 },
      url: "https://github.com/o/r/pull/7",
      isCheck: false,
      failed: false,
      jobId: "s1",
      door: null,
    });
    // "It happened": the done state of the units door.
    expect(e!.mark).toEqual({
      state: "done",
      tone: "textSecondary",
      glyph: "check",
    });
  });

  it("an answer by the viewer: 'You', Answered, the Job as the door, a mark that is not a failure", () => {
    const [e] = entries([answered(1)]);
    expect(e).toMatchObject({
      who: "You",
      action: "answer",
      verb: "Answered",
      door: { kind: "session", id: "s1" },
      jobId: "s1",
    });
    expect(e!.mark.state).toBe("done");
  });

  it("a check names its pull request by number; a check that names none has none", () => {
    const [named, loose] = entries([check(7, 2), check(null, 1)]);
    expect(named!.pr).toEqual({ repo: "o/r", number: 7 });
    expect(named!.isCheck).toBe(true);
    expect(loose!.pr).toBeNull();
  });

  it("a red check is failed and wears the danger mark", () => {
    const [e] = entries([check(7, 2, "failed")]);
    expect(e!.failed).toBe(true);
    expect(e!.mark).toMatchObject({ state: "failed", tone: "error" });
  });

  it("a late-recorded event keeps its 'recorded at'; an on-time one has none", () => {
    const late = { ...answered(1), recordedAt: at(9) };
    const [a] = entries([late]);
    const [b] = entries([answered(1)]);
    expect(a!.recordedAt).toBe(at(9));
    expect(b).not.toHaveProperty("recordedAt");
  });

  it("an Activity row reads through the activity verb and object", () => {
    const row = {
      id: "run:1",
      source: "run",
      occurredAt: at(3),
      actor: SYSTEM,
      action: "run",
      verb: "Ran",
      title: "Nightly digest",
      object: { kind: "run", id: "r1", name: null },
      proposalId: null,
      project: null,
      session: { id: "s9", title: "Other" },
      outcome: "succeeded",
      undo: null,
      error: null,
    } as ActivityRow;
    const [l] = activityLine(
      { events: [], truncated: false },
      [row],
      "trace"
    ).entries;
    expect(entryOf(l!)).toMatchObject({
      action: "run",
      verb: "Ran",
      text: "Ran Nightly digest",
      door: { kind: "run", id: "r1" },
      jobId: "s9",
    });
  });

  it("a goal event reads through its goal context: the step it moved to, the step as door", () => {
    const ev = {
      id: "h1",
      at: at(4),
      actor: YOU,
      kind: "step_moved",
      stageKey: "build",
      refs: {},
    } as unknown as TrackHistoryEvent;
    const [l] = activityLine(
      { events: [ev], truncated: false },
      [],
      "trace"
    ).entries;
    const e = entryOf(l!, {
      goal: {
        trackId: "t1",
        trackName: "Goal",
        stages: [{ key: "build", name: "Build" }],
      },
    });
    expect(e).toMatchObject({
      action: "move",
      verb: "Moved",
      text: "Moved to Build",
    });
    expect(e.door).toEqual({ kind: "track_stage", id: "build" });
  });
});

describe("groupEntries: fold, then group", () => {
  // Newest first: red check, 2 passes of #7, #7 opened, a loose pass, #8 opened.
  const timeline = () =>
    entries([
      check(7, 30, "failed"),
      check(7, 25),
      check(7, 20),
      opened(7, 10),
      check(null, 8),
      opened(8, 5),
    ]);

  it("passing checks fold into their pull request's row; a red check stands alone", () => {
    const rows = foldChecks(timeline());
    expect(rows.map((r) => r.entry.kind)).toEqual([
      "checks_finished", // the red one
      "pr_opened", // #7, with two passes folded
      "checks_finished", // the loose one: names no pull request
      "pr_opened", // #8
    ]);
    expect(rows[0]!.entry.failed).toBe(true);
    expect(rows[1]!.folded).toHaveLength(2);
    expect(rows[1]!.folded.every((c) => !c.failed && c.isCheck)).toBe(true);
    expect(rows[2]!.folded).toHaveLength(0);
    expect(rows[3]!.folded).toHaveLength(0);
  });

  it("folds by the PR number on the check, not by time order", () => {
    // #8 is the nearest PR row before the check, but the check ran on #7.
    const e = entries([check(7, 20), opened(8, 15), opened(7, 10)]);
    const rows = foldChecks(e);
    expect(rows.map((r) => r.entry.pr?.number)).toEqual([8, 7]);
    expect(rows[0]!.folded).toHaveLength(0);
    expect(rows[1]!.folded).toHaveLength(1);
  });

  it("a pass whose PR row is not in the list stands alone, and a check before its PR row folds into it", () => {
    expect(foldChecks(entries([check(9, 3)]))).toHaveLength(1);
    const early = foldChecks(entries([opened(7, 10), check(7, 2)]));
    expect(early).toHaveLength(1);
    expect(early[0]!.folded).toHaveLength(1);
  });

  it("nothing is dropped: every entry is a row or folded into one", () => {
    const rows = foldChecks(timeline());
    expect(rows.reduce((s, r) => s + 1 + r.folded.length, 0)).toBe(6);
  });

  it("groups by day in the viewer's zone, newest first", () => {
    const e = entries([
      answered(10),
      answered(-60), // 11:00 UTC, 17 Nov
      { ...answered(0), at: "2026-11-16T23:30:00.000Z" },
    ]);
    const utc = groupEntries(e, {
      by: "day",
      timeZone: "UTC",
      now: new Date("2026-11-17T13:00:00Z"),
    });
    expect(utc.map((g) => g.key)).toEqual(["day:2026-11-17", "day:2026-11-16"]);
    expect(utc[0]!.label).toEqual({ day: "2026-11-17", isToday: true });
    expect(utc[0]!.rows).toHaveLength(2);
    // 23:30 UTC on the 16th is already the 17th in Paris.
    const paris = groupEntries(e, {
      by: "day",
      timeZone: "Europe/Paris",
      now: new Date("2026-11-17T13:00:00Z"),
    });
    expect(paris.map((g) => g.key)).toEqual(["day:2026-11-17"]);
    expect(paris[0]!.rows).toHaveLength(3);
  });

  it("groups by Job, in order of first appearance", () => {
    const withJob = (id: string, job: string): DevTimelineEvent => ({
      ...answered(0),
      id,
      refs: { sessionId: job, slotLabel: "Pick" },
    });
    const e = entries([
      { ...withJob("a", "s1"), at: at(5) },
      { ...withJob("b", "s2"), at: at(4) },
      { ...withJob("c", "s1"), at: at(3) },
    ]);
    const groups = groupEntries(e, { by: "job", timeZone: "UTC" });
    expect(groups.map((g) => g.key)).toEqual(["job:s1", "job:s2"]);
    expect(groups[0]!.rows).toHaveLength(2);
    expect(groups[0]!.label).toEqual({ jobId: "s1" });
  });

  it("an entry of no Job still gets a group, never dropped", () => {
    const e = entries([merged(1, 1)], { jobId: undefined as never });
    const groups = groupEntries(e, { by: "job", timeZone: "UTC" });
    expect(groups.map((g) => g.key)).toEqual(["job:none"]);
  });

  it("session start reads as one entry of its Job", () => {
    const [e] = entries([started(0)]);
    expect(e).toMatchObject({ action: "start", verb: "Started", jobId: "s1" });
  });
});
