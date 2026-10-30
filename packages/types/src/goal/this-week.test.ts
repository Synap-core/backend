import { describe, expect, it } from "vitest";
import type { TrackParticipant } from "../units/index.js";
import {
  goalPinState,
  proposeThisWeek,
  THIS_WEEK_COPY,
  THIS_WEEK_MAX,
  thisWeekView,
  type ThisWeekGoalsRead,
  type ThisWeekRead,
} from "./this-week.js";
import type { GoalLike } from "./model.js";

const ME = "u-me";
const OTHER = "u-other";

const owner = (id: string): TrackParticipant => ({
  id: `p-${id}`,
  principalKind: "person",
  principalId: id,
  role: "owner",
  commitment: null,
  commitmentState: null,
  counterText: null,
  reportedReason: null,
  reportedAt: null,
  acknowledgedAt: null,
  decidedBy: id,
  decidedAt: "2026-10-01T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  silentSince: null,
  displayName: null,
});

type G = GoalLike & { updatedAt: string };
const goal = (id: string, hoursAgo: number, over: Partial<G> = {}): G => ({
  id,
  name: id,
  status: "active",
  verdict: null,
  verdictReason: null,
  direction: null,
  endState: null,
  criteria: [],
  dropConditions: [],
  workKind: null,
  uncertainty: null,
  kindConfirmedBy: null,
  inReview: false,
  waitingOn: [],
  participants: [owner(ME)],
  updatedAt: new Date(
    Date.UTC(2026, 9, 20) - hoursAgo * 3_600_000
  ).toISOString(),
  ...over,
});

const propose = (goals: G[], lastWeekPins: string[] = []) =>
  proposeThisWeek({
    goals,
    lastWeekPins,
    viewerId: ME,
    now: new Date("2026-10-20T08:00:00Z"),
  });

describe('proposeThisWeek — the ONE "This week" proposal', () => {
  it("keeps last week’s pins first, in the person’s order, however recent or urgent the rest is", () => {
    const goals = [
      goal("a", 100),
      goal("b", 200),
      goal("review", 1, { inReview: true }),
    ];
    expect(propose(goals, ["b", "a"])).toEqual(["b", "a", "review"]);
  });

  it("drops a pin that is no longer active (closed, dropped, paused, gone)", () => {
    const goals = [
      goal("closed", 1, { status: "completed", verdict: "met" }),
      goal("paused", 1, { status: "paused" }),
      goal("kept", 5),
    ];
    expect(propose(goals, ["closed", "paused", "gone", "kept"])).toEqual([
      "kept",
    ]);
  });

  it("then goals in review that the viewer JUDGES — not one someone else judges", () => {
    const mine = goal("mine", 50, { inReview: true });
    const theirs = goal("theirs", 1, {
      inReview: true,
      participants: [
        owner(OTHER),
        { ...owner(OTHER), id: "p-j", role: "judge" },
      ],
    });
    const recent = goal("recent", 2);
    expect(propose([theirs, recent, mine])).toEqual(["mine", "recent"]);
  });

  it("then goals waiting on the viewer: a person’s act (input, approval, access), or a commitment asked of them", () => {
    const approval = goal("approval", 90, {
      waitingOn: [{ reason: "approval", count: 1 }],
    });
    const outside = goal("outside", 80, {
      waitingOn: [{ reason: "outside_world", count: 1 }],
    });
    const asked = goal("asked", 95, {
      participants: [
        owner(OTHER),
        {
          ...owner(ME),
          id: "p-d",
          role: "delegate",
          commitment: "Size it",
          commitmentState: "proposed",
        },
      ],
    });
    const fresh = goal("fresh", 1);
    // approval + asked outrank fresher owned goals; outside_world is nobody's act.
    expect(propose([fresh, outside, approval, asked])).toEqual([
      "approval",
      "asked",
      "fresh",
    ]);
  });

  it("then the viewer’s own active goals, most recent activity first, never more than three", () => {
    const goals = [
      goal("old", 300),
      goal("newest", 1),
      goal("mid", 50),
      goal("older", 200),
    ];
    expect(propose(goals)).toEqual(["newest", "mid", "older"]);
    expect(propose(goals)).toHaveLength(THIS_WEEK_MAX);
  });

  it("never proposes a goal the viewer neither owns, judges, nor was asked on", () => {
    expect(
      propose([goal("theirs", 1, { participants: [owner(OTHER)] })])
    ).toEqual([]);
  });
});

describe("thisWeekView — This week's goals", () => {
  const list = [goal("a", 1), goal("b", 2)];
  const goals: ThisWeekGoalsRead<G> = { state: "read", goals: list };
  const read = (id: string): ThisWeekRead<G> =>
    id === "broken"
      ? { state: "failed" }
      : { state: "read", goal: list.find((g) => g.id === id) ?? goal(id, 9) };

  it("the person’s pins win, read by id in their order — even a goal outside the list read", () => {
    const v = thisWeekView({
      pinnedIds: ["far", "b"],
      readPinned: read,
      goals,
      viewerId: ME,
    });
    expect(v.source).toBe("kept");
    expect(v.provenance).toBe(THIS_WEEK_COPY.kept);
    expect(v.slots.map((s) => s.id)).toEqual(["far", "b"]);
  });

  it("a pin whose read failed keeps its slot (never vanishes while still filling the cap)", () => {
    const v = thisWeekView({
      pinnedIds: ["a", "broken"],
      readPinned: read,
      goals,
      viewerId: ME,
    });
    expect(v.slots.map((s) => s.read.state)).toEqual(["read", "failed"]);
  });

  it("proposes only over no pins — and nothing over pins it could not read", () => {
    expect(
      thisWeekView({ pinnedIds: [], readPinned: read, goals, viewerId: ME })
    ).toMatchObject({
      source: "proposed",
      provenance: THIS_WEEK_COPY.proposed,
    });
    expect(
      thisWeekView({
        pinnedIds: [],
        readPinned: read,
        goals,
        viewerId: ME,
      }).slots.map((s) => s.id)
    ).toEqual(["a", "b"]);
    expect(
      thisWeekView({ pinnedIds: null, readPinned: read, goals, viewerId: ME })
    ).toEqual({
      source: "unread",
      provenance: null,
      slots: [],
    });
  });

  it("over no pins, a goals list still being read is unread and a failed one is failed — never an empty week", () => {
    expect(
      thisWeekView({
        pinnedIds: [],
        readPinned: read,
        goals: { state: "loading" },
        viewerId: ME,
      })
    ).toEqual({
      source: "unread",
      provenance: null,
      slots: [],
    });
    expect(
      thisWeekView({
        pinnedIds: [],
        readPinned: read,
        goals: { state: "failed" },
        viewerId: ME,
      })
    ).toEqual({
      source: "failed",
      provenance: null,
      slots: [],
    });
    // A read list with nothing to propose IS the empty week — the one state that invites a goal.
    expect(
      thisWeekView({
        pinnedIds: [],
        readPinned: read,
        goals: { state: "read", goals: [] },
        viewerId: ME,
      })
    ).toEqual({
      source: "proposed",
      provenance: THIS_WEEK_COPY.proposed,
      slots: [],
    });
  });

  it("the person’s pins never wait on, nor fail with, the goals list (it is read only to propose)", () => {
    for (const state of ["loading", "failed"] as const) {
      const v = thisWeekView({
        pinnedIds: ["a"],
        readPinned: read,
        goals: { state },
        viewerId: ME,
      });
      expect(v.source).toBe("kept");
      expect(v.slots.map((s) => s.id)).toEqual(["a"]);
    }
  });

  it('one name, distinct from the calendar page "This week"', () => {
    expect(THIS_WEEK_COPY.title).toBe("This week's goals");
    expect(THIS_WEEK_COPY.title).not.toBe("This week");
    expect(THIS_WEEK_COPY.pin).toBe("Pin for this week");
  });
});

describe("goalPinState", () => {
  it("pinned → Unpin; a full week refuses a 4th with words; not read → no button state", () => {
    expect(goalPinState("a", ["a"])).toMatchObject({
      pinned: true,
      label: THIS_WEEK_COPY.unpin,
      refusal: null,
    });
    expect(goalPinState("d", ["a", "b", "c"])).toMatchObject({
      pinned: false,
      full: true,
      refusal: THIS_WEEK_COPY.full,
    });
    expect(goalPinState("a", null)).toBeNull();
  });
});
