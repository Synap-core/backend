/**
 * Unfinished captures in Needs-you (founder, 2026-10-12): one row per capture
 * that owes an answer or a filing decision, a door into the capture thread,
 * counted by the badge exactly as the list draws it.
 */

import { describe, it, expect } from "vitest";
import {
  countNeedsYou,
  unionNeedsYou,
  type OwedSlotSignalInput,
  type UnfinishedCaptureSignalInput,
} from "../needs-you-union.js";

const NOW = new Date("2026-10-12T10:00:00Z");
const capture = (
  sessionId: string,
  status: UnfinishedCaptureSignalInput["status"] = "suggested"
): UnfinishedCaptureSignalInput => ({
  sessionId,
  title: null,
  goal: `Idea of content for ${sessionId}`,
  updatedAt: new Date("2026-10-12T09:00:00Z"),
  projectId: "p-1",
  status,
});
const owed = (sessionId: string): OwedSlotSignalInput =>
  ({
    sessionId,
    label: "A thing",
    owedSince: NOW.toISOString(),
  }) as OwedSlotSignalInput;

describe("unfinished captures in Needs-you", () => {
  it("one row per capture: its door opens the thread, its status rides along", () => {
    const [row] = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [],
      unfinishedCaptures: [capture("s-1", "needs_answer")],
      now: NOW,
    });
    expect(row).toMatchObject({
      id: "capture:s-1",
      kind: "capture",
      title: "Idea of content for s-1",
      target: { kind: "session", id: "s-1", view: "room" },
      captureStatus: "needs_answer",
      sessionProjectId: "p-1",
      groupKey: "session:s-1",
      ageBucket: "recent",
      repeatCount: 1,
    });
  });

  it("a capture whose session is already drawn (owed slot, review) is not drawn twice", () => {
    const listed = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots: [owed("s-owed")],
      reviewSessions: [
        { id: "s-review", title: null, goal: "g", updatedAt: NOW },
      ],
      unfinishedCaptures: [
        capture("s-owed"),
        capture("s-review"),
        capture("s-free"),
      ],
      now: NOW,
    });
    expect(listed.filter((s) => s.kind === "capture").map((s) => s.id)).toEqual(
      ["capture:s-free"]
    );
  });

  it("the badge counts exactly the capture rows the list draws, as their own part", () => {
    const owedSlots = [owed("s-owed")];
    const unfinishedCaptures = [
      capture("s-owed"),
      capture("s-a"),
      capture("s-b"),
    ];
    const listed = unionNeedsYou({
      clusters: [],
      notifications: [],
      owedSlots,
      unfinishedCaptures,
      now: NOW,
    });
    const counted = countNeedsYou({
      distinctClusters: 0,
      clustersTruncated: false,
      clusters: [],
      notifications: [],
      notificationsTruncated: false,
      owedSlots,
      owedTruncated: false,
      unfinishedCaptures,
      capturesTruncated: true,
    });
    expect(counted.captures).toBe(2);
    expect(counted.needsYou).toBe(listed.length);
    expect(counted.needsYou).toBe(
      counted.decisions +
        counted.notifications +
        counted.blocked +
        counted.review +
        counted.captures
    );
    expect(counted.truncated).toBe(true);
  });
});
