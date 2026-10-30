import { describe, expect, it } from "vitest";
import type { TrackParticipant } from "../units/index.js";
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

describe("goals collection — filters", () => {
  it("four filters, in one order, with one set of words", () => {
    expect(GOAL_FILTERS).toEqual(["open", "in_review", "waiting", "ended"]);
    expect(GOAL_FILTERS.map(goalFilterLabel)).toEqual([
      "Open",
      "In review",
      "Waiting on",
      "Closed or dropped",
    ]);
  });

  it("Open = not ended; In review and Waiting on are marks inside an open goal", () => {
    const closed = g("c", {
      status: "completed",
      verdict: "met",
      inReview: true,
    });
    expect(goalMatchesFilter(g("a", { status: "proposed" }), "open")).toBe(
      true
    );
    expect(goalMatchesFilter(g("a", { status: "paused" }), "open")).toBe(true);
    expect(goalMatchesFilter(closed, "open")).toBe(false);
    expect(goalMatchesFilter(closed, "in_review")).toBe(false);
    expect(goalMatchesFilter(closed, "ended")).toBe(true);
    expect(
      goalMatchesFilter(
        g("d", { status: "archived", verdict: "impossible" }),
        "ended"
      )
    ).toBe(true);
  });

  it("Waiting on = a waiting mark with a count above zero — the mark's own rule", () => {
    expect(
      goalMatchesFilter(
        g("w", { waitingOn: [{ reason: "input", count: 0 }] }),
        "waiting"
      )
    ).toBe(false);
    expect(
      goalMatchesFilter(
        g("w", { waitingOn: [{ reason: "input", count: 2 }] }),
        "waiting"
      )
    ).toBe(true);
    expect(goalMatchesFilter(g("w", { waitingOn: null }), "waiting")).toBe(
      false
    );
  });

  it("only Closed or dropped reads the dropped goals", () => {
    expect(GOAL_FILTERS.map((f) => goalFilterQuery(f).includeArchived)).toEqual(
      [false, false, false, true]
    );
  });
});

describe("goals collection — order and rows", () => {
  it("in review first, then what waits on the viewer, then the most recently changed", () => {
    const goals = [
      g("old", { updatedAt: "2026-10-01T00:00:00.000Z" }),
      g("recent", { updatedAt: "2026-10-22T00:00:00.000Z" }),
      g("mine", {
        updatedAt: "2026-09-01T00:00:00.000Z",
        participants: [owner(ME)],
        waitingOn: [{ reason: "approval", count: 1 }],
      }),
      g("review", { updatedAt: "2026-08-01T00:00:00.000Z", inReview: true }),
    ];
    const c = goalCollection({ goals, filter: "open", viewerId: ME });
    expect(c.rows.map((r) => r.goal.id)).toEqual([
      "review",
      "mine",
      "recent",
      "old",
    ]);
    expect(c.filters.find((f) => f.key === "waiting")).toMatchObject({
      count: 1,
      selected: false,
    });
    expect(c.query).toEqual({ includeArchived: false });
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
