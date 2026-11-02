import { describe, expect, it } from "vitest";
import type { TrackParticipant } from "../units/index.js";
import type { GoalRunsRollup } from "../workers/goal.js";
import {
  GOAL_FILTERS,
  goalCollection,
  goalCollectionRow,
  goalFilterLabel,
  goalFilterQuery,
  goalMatchesFilter,
  type GoalListGoal,
} from "./index.js";

const ME = "u-me";
const OTHER = "u-other";

const owner = (principalId: string): TrackParticipant => ({
  id: `p-${principalId}`,
  principalKind: "person",
  principalId,
  role: "owner",
  commitment: null,
  commitmentState: null,
  counterText: null,
  reportedReason: null,
  reportedAt: null,
  acknowledgedAt: null,
  decidedBy: principalId,
  decidedAt: "2026-10-20T00:00:00.000Z",
  createdAt: "2026-10-20T00:00:00.000Z",
  silentSince: null,
  displayName: null,
});

const g = (id: string, over: Partial<GoalListGoal> = {}): GoalListGoal => ({
  id,
  name: `Goal ${id}`,
  status: "active",
  verdict: null,
  criteria: [],
  inReview: false,
  waitingOn: [],
  participants: [owner(OTHER)],
  projectId: "proj-1",
  updatedAt: "2026-10-20T00:00:00.000Z",
  ...over,
});

const runs = (over: Partial<GoalRunsRollup> = {}): GoalRunsRollup => ({
  rhythm: "Every day at 09:00 UTC",
  health: "healthy",
  workerCount: 1,
  runningCount: 1,
  pendingApprovals: 0,
  marks: [],
  lastRunAt: null,
  nextRunAt: null,
  ...over,
});

describe("goals collection — filters", () => {
  it("Open plus the five attention groups, in one order, with one set of words", () => {
    expect(GOAL_FILTERS).toEqual([
      "open",
      "needs_you",
      "repeating",
      "until_done",
      "failing",
      "off",
    ]);
    expect(GOAL_FILTERS.map(goalFilterLabel)).toEqual([
      "Open",
      "Needs you",
      "Repeating",
      "Until done",
      "Failing",
      "Off",
    ]);
  });

  it("Open = not ended; Off = ended, or every worker paused", () => {
    const closed = g("c", {
      status: "completed",
      verdict: "met",
      inReview: true,
    });
    expect(goalMatchesFilter(g("a", { status: "proposed" }), "open")).toBe(
      true
    );
    expect(goalMatchesFilter(closed, "open")).toBe(false);
    expect(goalMatchesFilter(closed, "needs_you", OTHER)).toBe(false);
    expect(goalMatchesFilter(closed, "off")).toBe(true);
    expect(
      goalMatchesFilter(
        g("d", { status: "archived", verdict: "impossible" }),
        "off"
      )
    ).toBe(true);
    const paused = g("p", {
      runs: runs({ runningCount: 0, health: "paused" }),
    });
    expect(goalMatchesFilter(paused, "open")).toBe(true);
    expect(goalMatchesFilter(paused, "off")).toBe(true);
  });

  it("Needs you = in review for its judge, waiting on the viewer, or run approvals — never someone else's wait", () => {
    const judged = g("j", {
      inReview: true,
      participants: [
        owner(OTHER),
        { ...owner(ME), id: "p-judge", role: "judge" },
      ],
    });
    expect(goalMatchesFilter(judged, "needs_you", ME)).toBe(true);
    expect(goalMatchesFilter(judged, "needs_you", "u-third")).toBe(false);
    const waits = g("w", {
      participants: [owner(ME)],
      waitingOn: [{ reason: "input", count: 2 }],
    });
    expect(goalMatchesFilter(waits, "needs_you", ME)).toBe(true);
    expect(goalMatchesFilter(waits, "needs_you", OTHER)).toBe(false);
    expect(
      goalMatchesFilter(
        g("w0", {
          participants: [owner(ME)],
          waitingOn: [{ reason: "input", count: 0 }],
        }),
        "needs_you",
        ME
      )
    ).toBe(false);
    const approvals = g("a", {
      participants: [owner(ME)],
      runs: runs({ pendingApprovals: 2 }),
    });
    expect(goalMatchesFilter(approvals, "needs_you", ME)).toBe(true);
    expect(goalMatchesFilter(approvals, "repeating", OTHER)).toBe(true);
  });

  it("Repeating, Until done and Failing read the goal's runs", () => {
    expect(goalMatchesFilter(g("r", { runs: runs() }), "repeating")).toBe(true);
    expect(
      goalMatchesFilter(
        g("u", {
          runs: runs({ workerCount: 0, runningCount: 0, rhythm: null }),
        }),
        "until_done"
      )
    ).toBe(true);
    expect(
      goalMatchesFilter(
        g("f", { runs: runs({ health: "failing" }) }),
        "failing"
      )
    ).toBe(true);
    expect(
      goalMatchesFilter(
        g("o", { runs: runs({ health: "off", runningCount: 1 }) }),
        "failing"
      )
    ).toBe(true);
  });

  it("every filter reads the runs; only Off reads the dropped goals", () => {
    expect(GOAL_FILTERS.map((f) => goalFilterQuery(f).includeArchived)).toEqual(
      [false, false, false, false, false, true]
    );
    expect(
      GOAL_FILTERS.every((f) => goalFilterQuery(f).include[0] === "runs")
    ).toBe(true);
  });
});

describe("goals collection — order and rows", () => {
  it("needs you first, then failing, repeating, until done; then the most recently changed", () => {
    const goals = [
      g("old", {
        updatedAt: "2026-10-01T00:00:00.000Z",
        runs: runs({ workerCount: 0, runningCount: 0 }),
      }),
      g("recent", { updatedAt: "2026-10-22T00:00:00.000Z", runs: runs() }),
      g("mine", {
        updatedAt: "2026-09-01T00:00:00.000Z",
        participants: [owner(ME)],
        waitingOn: [{ reason: "approval", count: 1 }],
        runs: runs(),
      }),
      g("broken", {
        updatedAt: "2026-08-01T00:00:00.000Z",
        runs: runs({ health: "failing" }),
      }),
      g("ended", { status: "completed", verdict: "met", runs: runs() }),
    ];
    const c = goalCollection({ goals, filter: "open", viewerId: ME });
    expect(c.rows.map((r) => r.goal.id)).toEqual([
      "mine",
      "broken",
      "recent",
      "old",
    ]);
    expect(c.rows.map((r) => r.group)).toEqual([
      "needs_you",
      "failing",
      "running",
      "until_done",
    ]);
    expect(c.filters.find((f) => f.key === "needs_you")).toMatchObject({
      count: 1,
      selected: false,
    });
    expect(c.query).toEqual({ includeArchived: false, include: ["runs"] });
    expect(c.summary).toBe(
      "1 needs you · 1 failing · 1 runs on its own · 1 until done"
    );
    expect(c.runsUnread).toBe(0);
  });

  it("a goal read without its runs is said, never guessed failing or repeating", () => {
    const c = goalCollection({ goals: [g("x")], filter: "open", viewerId: ME });
    expect(c.rows[0]).toMatchObject({ group: "until_done", runsRead: false });
    expect(c.runsUnread).toBe(1);
  });

  it("the row carries the rhythm, the run marks, the needs-you reason and the one verb", () => {
    const marks = [
      { runId: "r1", mark: "done" as const, at: "2026-10-30T09:00:00.000Z" },
    ];
    const row = goalCollectionRow(
      g("a", {
        participants: [owner(ME)],
        runs: runs({ pendingApprovals: 2, marks }),
      }),
      ME
    );
    expect(row).toMatchObject({
      group: "needs_you",
      groupLabel: "Needs you",
      rhythm: "Every day at 09:00 UTC",
      runMarks: marks,
      needsYou: { count: 2, reason: "2 runs to approve" },
      waitsOnYou: true,
      row: {
        cls: "blocking",
        reason: "2 runs to approve",
        verb: { action: "approve" },
      },
    });
    const failing = goalCollectionRow(
      g("f", { runs: runs({ health: "failing" }) }),
      ME
    );
    expect(failing.row.verb).toMatchObject({ action: "open", label: "Open" });
    expect(goalCollectionRow(g("r", { runs: runs() }), ME).row.verb).toBeNull();
  });

  it("an unnamed goal still reads as a goal; the count is text, never a percent", () => {
    const row = goalCollectionRow(
      g("u", {
        name: "  ",
        criteria: [
          {
            key: "a",
            statement: "a",
            check: { kind: "human" },
            acceptance: null,
            mark: "met",
            acceptanceState: "accepted",
            meaning: "judged",
            currentValue: null,
          },
          {
            key: "b",
            statement: "b",
            check: { kind: "human" },
            acceptance: null,
            mark: "claimed",
            acceptanceState: "waiting",
            meaning: "judged",
            currentValue: null,
          },
        ],
      }),
      ME
    );
    expect(row.row.title).toBe("Untitled goal");
    expect(row.count).toBe("1 of 2 met · 1 claimed");
    expect(row.row.reason).toBe(row.count);
  });

  it("a row that waits on the viewer is blocking; the project is the source only when named", () => {
    const mine = goalCollectionRow(
      g("m", {
        participants: [owner(ME)],
        waitingOn: [{ reason: "input", count: 1 }],
      }),
      ME,
      "Synap"
    );
    expect(mine).toMatchObject({
      waitsOnYou: true,
      row: { cls: "blocking", source: { kind: "project", label: "Synap" } },
    });
    expect(mine.marks.map((m) => m.label)).toEqual(["Waiting on input"]);
    const theirs = goalCollectionRow(g("t", { inReview: true }), ME);
    expect(theirs).toMatchObject({
      waitsOnYou: false,
      row: { cls: "happening", source: null },
    });
  });
});
