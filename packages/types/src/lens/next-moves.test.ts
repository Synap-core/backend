import { describe, expect, it } from "vitest";
import {
  lensHeaderModel,
  lensNextHour,
  lensNextMoveRow,
  lensNextMoveCandidates,
  nextMoveKeyOfRow,
  rankNextMoves,
  lensRowOfNextMove,
  NEXT_HOUR_PICKS,
  type LensNeedsYouSignal,
  type LensPage,
  type LensPageClass,
  type LensPageSignal,
  type NextMoveCandidate,
  type NextMoveWire,
} from "./index.js";

type Sig = LensPageSignal & LensNeedsYouSignal;
const NOW = new Date("2026-10-05T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) =>
  new Date(NOW.getTime() - days * DAY).toISOString();

function sig(id: string, over: Partial<Sig> = {}): Sig {
  return {
    id,
    kind: "owed-slot",
    title: `T ${id}`,
    occurredAt: "2026-10-05T10:00:00.000Z",
    target: { kind: "session", id: "s-" + id },
    count: 1,
    groupKey: null,
    ageBucket: "recent",
    repeatCount: 1,
    ...over,
  };
}

function cls(rows: Sig[]): LensPageClass<Sig> {
  return {
    rows,
    total: rows.length,
    truncated: false,
    hasMore: false,
    unreadable: [],
  };
}

function wire(id: string, over: Partial<NextMoveWire> = {}): NextMoveWire {
  return {
    key: `entity:${id}`,
    objectKind: "task",
    title: `Task ${id}`,
    door: { kind: "entity", id },
    action: "start",
    unblocks: 0,
    waitingSince: null,
    project: null,
    track: null,
    draftReady: false,
    ...over,
  };
}

function page(over: Partial<LensPage<Sig>> = {}): LensPage<Sig> {
  return {
    blocking: cls([]),
    proposed: cls([]),
    happening: cls([]),
    produced: cls([]),
    happened: cls([]),
    status: null,
    statusUnreadable: false,
    ...over,
  };
}

const start = (w: NextMoveWire): NextMoveCandidate => ({
  tier: "start",
  row: lensRowOfNextMove(w),
  facts: {
    unblocks: w.unblocks,
    waitingSince: w.waitingSince,
    project: w.project,
    track: w.track,
    draftReady: w.draftReady,
  },
});

describe("rankNextMoves — THE ranking", () => {
  it("tiers: answer before start before watch, whatever the input order", () => {
    const answer: NextMoveCandidate = {
      tier: "answer",
      row: { ...lensRowOfNextMove(wire("a")), key: "ans", cls: "blocking" },
    };
    const watch: NextMoveCandidate = {
      tier: "watch",
      row: { ...lensRowOfNextMove(wire("w")), key: "watch", cls: "happening" },
    };
    const ranked = rankNextMoves([watch, start(wire("s")), answer], NOW);
    expect(ranked.map((m) => m.tier)).toEqual(["answer", "start", "watch"]);
  });

  it("start: unblocks outranks a draft, a draft outranks waiting, waiting longest first", () => {
    const ranked = rankNextMoves(
      [
        start(wire("old", { waitingSince: ago(9) })),
        start(wire("newer", { waitingSince: ago(2) })),
        start(wire("draft", { draftReady: true, waitingSince: ago(1) })),
        start(wire("unblocks", { unblocks: 2 })),
        start(wire("nodate")),
      ],
      NOW
    );
    expect(ranked.map((m) => m.row.title)).toEqual([
      "Task unblocks",
      "Task draft",
      "Task old",
      "Task newer",
      "Task nodate",
    ]);
  });

  it("answer and watch keep the pod's order (never re-scored)", () => {
    const a = (k: string, unblocks: number): NextMoveCandidate => ({
      tier: "answer",
      row: { ...lensRowOfNextMove(wire(k)), key: k, cls: "blocking" },
      facts: { unblocks },
    });
    const ranked = rankNextMoves([a("first", 0), a("second", 9)], NOW);
    expect(ranked.map((m) => m.row.key)).toEqual(["first", "second"]);
    expect(ranked[0]!.reasons).toEqual([]);
  });

  it("reason chips are facts: Unblocks N · AI draft ready · Waited Nd · project · track (doors)", () => {
    const [m] = rankNextMoves(
      [
        start(
          wire("x", {
            unblocks: 3,
            draftReady: true,
            waitingSince: ago(4.5),
            project: { id: "p1", name: "Launch" },
            track: { id: "t1", name: "Pricing" },
          })
        ),
      ],
      NOW
    );
    expect(m!.reasons).toEqual([
      { kind: "unblocks", count: 3, label: "Unblocks 3", tone: "neutral" },
      { kind: "draft-ready", label: "Draft ready", tone: "ai" },
      { kind: "waited", days: 4, label: "Waited 4d", tone: "neutral" },
      {
        kind: "project",
        label: "Launch",
        door: { kind: "project", id: "p1" },
        tone: "neutral",
      },
      {
        kind: "track",
        label: "Pricing",
        door: { kind: "track", id: "t1" },
        tone: "neutral",
      },
    ]);
  });

  it("waiting a week or more reads as stuck (error tone)", () => {
    const [m] = rankNextMoves(
      [start(wire("z", { waitingSince: ago(9) }))],
      NOW
    );
    expect(m!.reasons).toEqual([
      { kind: "waited", days: 9, label: "Waited 9d", tone: "error" },
    ]);
  });

  it("no chip is invented: zero dependents, under a day, nothing named ⇒ no chips", () => {
    const [m] = rankNextMoves(
      [start(wire("y", { waitingSince: ago(0.5) }))],
      NOW
    );
    expect(m!.reasons).toEqual([]);
  });

  it("a pick's verb is its own (Start / Resume) and its mark the shared unit state", () => {
    expect(lensRowOfNextMove(wire("s")).verb).toEqual({
      action: "start",
      label: "Start",
    });
    const resumed = lensRowOfNextMove(wire("r", { action: "resume" }));
    expect(resumed.verb).toEqual({ action: "resume", label: "Resume" });
    expect(resumed.state).toEqual({ idle: true });
    expect(nextMoveKeyOfRow(resumed)).toBe("entity:r");
    expect(nextMoveKeyOfRow({ key: "live:1" })).toBeNull();
  });
});

describe("header and picker read ONE ranking — they never disagree", () => {
  const blocking = cls([sig("b1", { title: "Approve the plan" }), sig("b2")]);
  const happening = cls([
    sig("live", {
      kind: "live-session",
      title: "Agent drafting",
      target: { kind: "session", id: "L" },
    }),
  ]);
  const picks = {
    rows: [
      wire("low", { waitingSince: ago(1) }),
      wire("high", { unblocks: 4 }),
    ],
    truncated: false,
    unreadable: [],
  };
  const cases: Array<[string, LensPage<Sig>]> = [
    ["blocking + picks + happening", page({ blocking, happening, picks })],
    ["picks + happening", page({ happening, picks })],
    ["picks only", page({ picks })],
    ["blocking + happening (a header page)", page({ blocking, happening })],
    ["happening only (a header page)", page({ happening })],
  ];

  for (const [name, p] of cases) {
    it(`${name}: the header's move IS rank[0] of the page's moves`, () => {
      const header = lensNextMoveRow(p, NOW);
      const rank0 = rankNextMoves(lensNextMoveCandidates(p), NOW)[0]!.row;
      expect(header).toEqual(rank0);
      const hour = lensNextHour(p, NOW);
      if (p.blocking.rows.length > 0) {
        // "Only you can answer" first: the Needs-you section's first row.
        expect(header!.cls).toBe("blocking");
        expect(header!.title).toBe("Approve the plan");
      } else if (hour && hour.picks.length > 0) {
        // No answer tier ⇒ the header's move is the picker's FIRST pick.
        expect(header).toEqual(hour.picks[0]!.row);
      } else {
        expect(header!.cls).toBe("happening");
      }
    });
  }

  it("the picker's first pick is the highest-scored start move (Unblocks first)", () => {
    const hour = lensNextHour(page({ blocking, happening, picks }), NOW)!;
    expect(hour.picks.map((m) => m.row.title)).toEqual([
      "Task high",
      "Task low",
    ]);
    expect(hour.picks[0]!.reasons[0]).toMatchObject({
      kind: "unblocks",
      count: 4,
    });
  });

  it("a header page (no picks) keeps the v2 move: Blocking with its own verb, else Happening", () => {
    const model = lensHeaderModel({
      scopeKind: "project",
      state: {},
      counts: { blocking: 2, happening: 1, produced: 0 },
      nextMove: lensNextMoveRow(page({ blocking, happening }), NOW),
    });
    expect(model.nextMove).toMatchObject({
      section: "blocking",
      text: "Approve the plan",
    });
    expect(
      lensHeaderModel({
        scopeKind: "project",
        state: {},
        counts: { blocking: 0, happening: 1, produced: 0 },
        nextMove: lensNextMoveRow(page({ happening }), NOW),
      }).nextMove
    ).toMatchObject({ section: "happening", text: "Agent drafting" });
  });
});

describe("lensNextHour — the picker", () => {
  it("not asked ⇒ null (never 'nothing to do')", () => {
    expect(lensNextHour(page(), NOW)).toBeNull();
    expect(lensNextHour(null, NOW)).toBeNull();
  });

  it("caps at three, and a skipped pick yields its slot to the next one", () => {
    const rows = ["a", "b", "c", "d"].map((k, i) =>
      wire(k, { unblocks: 4 - i })
    );
    const p = page({ picks: { rows, truncated: false, unreadable: [] } });
    expect(lensNextHour(p, NOW)!.picks.map((m) => m.row.title)).toEqual([
      "Task a",
      "Task b",
      "Task c",
    ]);
    expect(NEXT_HOUR_PICKS).toBe(3);
    const hidden = new Set(["entity:b"]);
    expect(
      lensNextHour(p, NOW, { hidden })!.picks.map((m) => m.row.title)
    ).toEqual(["Task a", "Task c", "Task d"]);
  });

  it("a failed half is failed / partial — never a calm empty", () => {
    expect(
      lensNextHour(
        page({ picks: { rows: [], truncated: true, unreadable: ["tasks"] } }),
        NOW
      )!.status
    ).toBe("failed");
    expect(
      lensNextHour(
        page({
          picks: { rows: [wire("a")], truncated: true, unreadable: ["tasks"] },
        }),
        NOW
      )!.status
    ).toBe("partial");
    expect(
      lensNextHour(
        page({ picks: { rows: [], truncated: false, unreadable: [] } }),
        NOW
      )!.status
    ).toBe("ready");
  });
});
