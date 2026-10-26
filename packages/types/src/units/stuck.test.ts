import { describe, it, expect } from "vitest";
import {
  deriveStuckChains,
  SESSION_GONE_QUIET_MS,
  type StuckSessionRow,
} from "./stuck.js";

const NOW = Date.parse("2026-10-23T12:00:00Z");
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

/** An open session, recorded activity `idleMin` ago, nothing owed. */
function open(
  id: string,
  idleMin: number,
  extra: Partial<StuckSessionRow> = {}
): StuckSessionRow {
  return {
    id,
    title: id.toUpperCase(),
    status: "active",
    unitFacts: { owedFromYou: 0, pendingDecisions: 0 },
    live: { turnInFlight: false, lastAt: minAgo(idleMin) },
    ...extra,
  };
}
const owing = { unitFacts: { owedFromYou: 1, pendingDecisions: 0 } };
const chains = (rows: StuckSessionRow[]) =>
  deriveStuckChains(rows, { now: NOW });

/**
 * Each case names the rule it would rule OUT — a row every plausible rule
 * agrees on is decoration.
 */
describe("deriveStuckChains — the root comes first", () => {
  it("a session waiting on one that needs you: root = the one that needs you", () => {
    // Rules out listing the WAITING session as the thing to act on.
    const out = chains([
      open("r", 2, owing),
      open("d", 2, { blockedBy: ["r"] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.cause).toBe("needs_you");
    expect(out[0]!.root.id).toBe("r");
    expect(out[0]!.holds).toEqual([
      { id: "d", title: "D", status: "active", depth: 1 },
    ]);
  });

  it("follows the chain transitively, nearest first, and the middle is no root", () => {
    // Rules out a one-hop walk (d2 would be missing) and a chain per hop.
    const out = chains([
      open("r", 2, owing),
      open("d1", 45, { blockedBy: ["r"] }),
      open("d2", 45, { blockedBy: ["d1"] }),
    ]);
    expect(out.map((c) => c.root.id)).toEqual(["r"]);
    expect(out[0]!.holds.map((h) => [h.id, h.depth])).toEqual([
      ["d1", 1],
      ["d2", 2],
    ]);
  });

  it("a needs-you session that holds nothing is the Inbox's, not stuck work", () => {
    // Rules out copying every needs-you row into "What's stuck".
    expect(chains([open("r", 2, owing), open("x", 2)])).toEqual([]);
  });

  it("a blocker that is WORKING holds nobody up for long — no chain", () => {
    // Rules out "blocked ⇒ stuck": waiting on live work is the normal case.
    expect(
      chains([
        open("b", 1, { live: { turnInFlight: true, lastAt: minAgo(1) } }),
        open("d", 50, { blockedBy: ["b"] }),
      ])
    ).toEqual([]);
  });

  it("a legacy row (no unitFacts) needs you by its move's owner", () => {
    const out = chains([
      {
        id: "r",
        title: "R",
        status: "active",
        nextMove: { kind: "owed_slot", actor: "user" },
        live: { turnInFlight: false, lastAt: minAgo(1) },
      },
      open("d", 1, { blockedBy: ["r"] }),
    ]);
    expect(out.map((c) => c.cause)).toEqual(["needs_you"]);
  });

  it("an agent draft never needs you, even when its facts say owed", () => {
    // Rules out a rule that reads unitFacts without the draft exclusion.
    const out = chains([
      open("r", 5, { ...owing, triage: { pending: true } }),
      open("d", 5, { blockedBy: ["r"] }),
    ]);
    expect(out).toEqual([]);
  });
});

describe("deriveStuckChains — gone quiet (decision 12)", () => {
  const holdOne = (root: StuckSessionRow) =>
    chains([root, open("d", 1, { blockedBy: [root.id] })]);

  it("the threshold is 30 minutes of nothing recorded", () => {
    expect(SESSION_GONE_QUIET_MS).toBe(30 * 60_000);
    // 29 min: still within the threshold — rules out a "working window" (5 min) rule.
    expect(holdOne(open("r", 29))).toEqual([]);
    const out = holdOne(open("r", 31));
    expect(out.map((c) => c.cause)).toEqual(["gone_quiet"]);
    expect(out[0]!.quietForMs).toBe(31 * 60_000);
  });

  it("a turn in flight is never quiet, whatever the last activity", () => {
    expect(
      holdOne(
        open("r", 90, { live: { turnInFlight: true, lastAt: minAgo(90) } })
      )
    ).toEqual([]);
  });

  it("an unmeasured clock claims nothing: liveness failed, not read, or nothing yet", () => {
    // Rules out folding "unmeasured" into "quiet" (CLAUDE.md: empty ≠ failed).
    expect(holdOne(open("r", 0, { live: null }))).toEqual([]);
    expect(holdOne(open("r", 0, { live: undefined }))).toEqual([]);
    expect(
      holdOne(open("r", 0, { live: { turnInFlight: false, lastAt: null } }))
    ).toEqual([]);
  });

  it("a scheduled session waits for its time — never quiet", () => {
    expect(holdOne(open("r", 600, { status: "scheduled" }))).toEqual([]);
  });

  it("a stale session is quiet (the reaper said so), measured when it can be", () => {
    const out = holdOne(open("r", 120, { status: "stale" }));
    expect(out.map((c) => [c.cause, c.quietForMs])).toEqual([
      ["gone_quiet", 120 * 60_000],
    ]);
    const blind = holdOne(open("r", 0, { status: "stale", live: null }));
    expect(blind.map((c) => [c.cause, c.quietForMs])).toEqual([
      ["gone_quiet", null],
    ]);
  });

  it("a quiet session held by an OPEN blocker is not a root — its blocker is", () => {
    // Rules out naming every quiet session in the chain as its own root.
    const out = chains([
      open("r", 60),
      open("b", 60, { blockedBy: ["r"] }),
      open("c", 60, { blockedBy: ["b"] }),
    ]);
    expect(out.map((c) => c.root.id)).toEqual(["r"]);
    expect(out[0]!.holds.map((h) => h.id)).toEqual(["b", "c"]);
  });

  it("a DELIVERED blocker holds nothing: its dependent can be the quiet root", () => {
    // Rules out "has any blockedBy ⇒ held" (delivered edges are history).
    const out = chains([
      open("x", 600, { status: "closed" }),
      open("r", 45, { blockedBy: ["x"] }),
      open("d", 1, { blockedBy: ["r"] }),
    ]);
    expect(out.map((c) => [c.root.id, c.cause])).toEqual([["r", "gone_quiet"]]);
  });
});

describe("deriveStuckChains — a dropped head", () => {
  it("a session whose blocker was cancelled re-plans — listed even holding nothing", () => {
    // Rules out treating a dropped blocker as cleared (the 2026-10-22 rule),
    // and the "a chain must hold something" rule reaching this cause.
    const out = chains([
      open("x", 600, { status: "cancelled" }),
      open("r", 1, { blockedBy: ["x"] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.cause).toBe("blocker_dropped");
    expect(out[0]!.root.id).toBe("r");
    expect(out[0]!.dropped).toEqual([
      { id: "x", title: "X", status: "cancelled" },
    ]);
    expect(out[0]!.holds).toEqual([]);
  });

  it("a failed blocker is dropped too, and the dependents ride in the chain", () => {
    const out = chains([
      open("x", 600, { status: "failed" }),
      open("r", 1, { blockedBy: ["x"] }),
      open("d", 1, { blockedBy: ["r"] }),
    ]);
    expect(
      out.map((c) => [c.root.id, c.cause, c.holds.map((h) => h.id)])
    ).toEqual([["r", "blocker_dropped", ["d"]]]);
  });

  it("the pod's next move wins: a REPLACED dropped blocker is waiting, not a re-plan", () => {
    // Rules out reading the page's edges over the pod's `replaces`-aware move.
    const out = chains([
      open("x", 600, { status: "cancelled" }),
      open("x2", 1, { live: { turnInFlight: true, lastAt: minAgo(1) } }),
      open("r", 1, {
        blockedBy: ["x"],
        nextMove: {
          kind: "waiting_on_session",
          actor: "none",
          sessionId: "x2",
        },
      }),
    ]);
    expect(out).toEqual([]);
  });

  it("the pod's dropped blocker off the page still makes a chain, with no named blocker", () => {
    const out = chains([
      open("r", 1, {
        blockedBy: ["gone"],
        nextMove: { kind: "blocker_dropped", actor: "ai", sessionId: "gone" },
      }),
    ]);
    expect(out.map((c) => [c.cause, c.dropped])).toEqual([
      ["blocker_dropped", []],
    ]);
  });

  it("a session that needs you outranks its own dropped blocker", () => {
    // Same order as the pod's next move: what the person can do NOW first.
    const out = chains([
      open("x", 600, { status: "cancelled" }),
      open("r", 1, { ...owing, blockedBy: ["x"] }),
      open("d", 1, { blockedBy: ["r"] }),
    ]);
    expect(out.map((c) => c.cause)).toEqual(["needs_you"]);
  });
});

describe("deriveStuckChains — the list", () => {
  it("orders by who acts: you, then re-plan, then quiet; more held first", () => {
    const out = chains([
      open("q", 90),
      open("q-d", 1, { blockedBy: ["q"] }),
      open("x", 600, { status: "cancelled" }),
      open("p", 1, { blockedBy: ["x"] }),
      open("y1", 1, owing),
      open("y1-d", 1, { blockedBy: ["y1"] }),
      open("y2", 1, owing),
      open("y2-a", 1, { blockedBy: ["y2"] }),
      open("y2-b", 1, { blockedBy: ["y2"] }),
    ]);
    expect(out.map((c) => c.root.id)).toEqual(["y2", "y1", "p", "q"]);
  });

  it("an ended dependent is held by nothing", () => {
    expect(
      chains([
        open("r", 2, owing),
        open("d", 2, { status: "closed", blockedBy: ["r"] }),
      ])
    ).toEqual([]);
  });

  it("a session held by two stuck roots appears in both", () => {
    const out = chains([
      open("a", 1, owing),
      open("b", 90),
      open("d", 1, { blockedBy: ["a", "b"] }),
    ]);
    expect(out.map((c) => [c.root.id, c.holds.map((h) => h.id)])).toEqual([
      ["a", ["d"]],
      ["b", ["d"]],
    ]);
  });

  it("a cycle of open sessions has no root, and the walk ends", () => {
    expect(
      chains([
        open("a", 90, { blockedBy: ["b"] }),
        open("b", 90, { blockedBy: ["a"] }),
      ])
    ).toEqual([]);
    // A cycle BELOW a root is walked once.
    const out = chains([
      open("r", 1, owing),
      open("a", 1, { blockedBy: ["r", "b"] }),
      open("b", 1, { blockedBy: ["a"] }),
    ]);
    expect(out[0]!.holds.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("titles come from the one title door (goal's first line when untitled)", () => {
    const out = chains([
      open("r", 2, { ...owing, title: null, goal: "Ship the rail\nand more" }),
      open("d", 2, { blockedBy: ["r"] }),
    ]);
    expect(out[0]!.root.title).toBe("Ship the rail");
  });
});
