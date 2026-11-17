/**
 * markOf: the CORRECT mark for concrete things, each value written out (a
 * sameness check against the door it calls would pass on a wrong mapping).
 */
import { describe, expect, it } from "vitest";

import type { ActivityActor, ActivityRow } from "../activity/index.js";
import type { DevTimelineEvent } from "../units/timeline.js";
import { activityLine } from "./activity-line.js";
import { markOf } from "./mark.js";
import { requestsOf, type RequestSignal } from "./requests.js";

const SYSTEM: ActivityActor = { kind: "system", id: null, name: null };

const row = (over: Partial<RequestSignal & { waitKind?: string }>) =>
  ({
    id: "slot:s1:pick",
    kind: "owed-slot",
    title: "Pick",
    count: 1,
    groupKey: "session:s1",
    ageBucket: "recent",
    repeatCount: 1,
    ...over,
  }) as RequestSignal & { waitKind?: string };

function entryOf(e: Partial<DevTimelineEvent> & { kind: string }) {
  const event = {
    id: "e1",
    at: "2026-11-16T10:00:00.000Z",
    actor: SYSTEM,
    refs: {},
    ...e,
  } as DevTimelineEvent;
  return activityLine({ events: [event], truncated: false }, [], "trace")
    .entries[0]!;
}

function rowEntry(outcome: ActivityRow["outcome"]) {
  const r = {
    id: "run:1",
    source: "run",
    occurredAt: "2026-11-16T10:00:00.000Z",
    actor: SYSTEM,
    action: "run",
    verb: "Ran",
    title: "Nightly",
    object: { kind: "run", id: "1", name: "Nightly" },
    proposalId: null,
    project: null,
    session: null,
    outcome,
    undo: null,
    error: null,
  } as ActivityRow;
  return activityLine({ events: [], truncated: false }, [r], "trace")
    .entries[0]!;
}

describe("markOf", () => {
  it("a request waiting on approval reads needs review: primary scales", () => {
    const [req] = requestsOf([row({ waitKind: "approval" })]).headline;
    expect(markOf({ kind: "request", request: req! })).toEqual({
      state: "needs_review",
      tone: "primary",
      glyph: "scales",
    });
  });

  it("a failed request is failed, whatever its wait kind", () => {
    const [req] = requestsOf([
      row({
        id: "notification:n1",
        kind: "notification",
        notificationType: "automation.broken",
        waitKind: "approval",
      }),
    ]).headline;
    expect(markOf({ kind: "request", request: req! })).toEqual({
      state: "failed",
      tone: "error",
      glyph: "alert",
    });
  });

  it("a paused move wears the waiting tone, warning, with the pause glyph", () => {
    const entry = entryOf({
      kind: "status_moved",
      from: "active",
      to: "paused",
      category: "paused",
      reason: null,
      hold: null,
    } as Partial<DevTimelineEvent> & { kind: string });
    expect(markOf({ kind: "activity", entry })).toEqual({
      state: "paused",
      tone: "warning",
      glyph: "pause",
    });
  });

  it("a rejected decision is muted, never done", () => {
    const entry = entryOf({
      kind: "decision_answered",
      title: "Create task",
      decision: "rejected",
      note: null,
      refs: { proposalId: "p1" },
    } as Partial<DevTimelineEvent> & { kind: string });
    expect(markOf({ kind: "activity", entry })).toEqual({
      state: "rejected",
      tone: "textMuted",
      glyph: "dashed-circle",
    });
  });

  it("an Activity row wears its own outcome: reverted muted, running at work", () => {
    expect(markOf({ kind: "activity", entry: rowEntry("reverted") })).toEqual({
      state: "reverted",
      tone: "textMuted",
      glyph: "dashed-circle",
    });
    expect(markOf({ kind: "activity", entry: rowEntry("running") })).toEqual({
      state: "running",
      tone: "ai",
      glyph: "spark",
    });
    expect(markOf({ kind: "activity", entry: rowEntry("waiting") })).toEqual({
      state: "waiting",
      tone: "primary",
      glyph: "person",
    });
  });
});
