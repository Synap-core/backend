/**
 * deriveRunActivity — fixtures chosen where the plausible WRONG rules disagree
 * with the right one (guards-and-tests.md: a row that rules nothing out is
 * decoration). Each `it` names the rule it rules out.
 */

import { describe, expect, it } from "vitest";
import {
  ACTIVITY_HISTORY_CAP,
  capActivityGroups,
  deriveRunActivity,
  STEP_PHASES,
  stepMark,
  type SessionActivityItem,
  type SessionActivityWire,
} from "./index.js";

let seq = 0;
function item(over: Partial<SessionActivityItem>): SessionActivityItem {
  seq += 1;
  return {
    id: `i${seq}`,
    at: new Date(Date.UTC(2026, 9, 4, 12, 0, seq)),
    kind: "write",
    status: "done",
    turnId: null,
    action: "create",
    objectKind: "task",
    objectId: `obj${seq}`,
    objectTitle: null,
    title: null,
    error: null,
    proposalId: null,
    actor: null,
    ...over,
  };
}

function wire(
  items: SessionActivityItem[],
  over: Partial<SessionActivityWire> = {}
): SessionActivityWire {
  return {
    sessionId: "s1",
    items,
    truncated: false,
    terminal: false,
    live: { turnInFlight: false, since: null, lastAt: null },
    unreadable: [],
    ...over,
  };
}

describe("the Now line — a recorded fact, never inferred from status", () => {
  it("names the running tool step when an IS turn is in flight", () => {
    const v = deriveRunActivity(
      wire(
        [
          item({
            kind: "tool",
            action: "search_unified",
            turnId: "t1",
            status: "done",
            title: "Searching your workspace…",
          }),
          item({
            kind: "tool",
            action: "send_email",
            turnId: "t1",
            status: "running",
            title: "Drafting the email…",
          }),
        ],
        { live: { turnInFlight: true, since: new Date(), lastAt: null } }
      )
    );
    expect(v.now?.mode).toBe("now");
    expect(v.now?.label).toBe("Drafting the email");
    // The live step is the Now line, not ALSO a history row.
    expect(
      v.groups.flatMap((g) => g.steps).some((s) => s.phase === "now")
    ).toBe(false);
  });

  it("rules out 'active session = working': nothing in flight ⇒ mode 'last', never 'now'", () => {
    // The session row would be `active`; the wire carries no in-flight turn.
    const v = deriveRunActivity(
      wire([
        item({ action: "create", objectKind: "task", objectTitle: "Ship it" }),
      ])
    );
    expect(v.now?.mode).toBe("last");
    expect(v.now?.label).toBe('Created Task "Ship it"');
  });

  it("a running call in a turn that is NOT in flight is unsettled, never 'now' or 'done'", () => {
    const v = deriveRunActivity(
      wire([
        item({
          kind: "tool",
          action: "send_email",
          turnId: "old",
          status: "running",
        }),
      ])
    );
    const [g] = v.groups;
    expect(g?.phase).toBe("unsettled");
    expect(v.now?.mode).toBe("last");
  });

  it("only the LATEST turn is live — a stale running call in an older turn stays unsettled", () => {
    const v = deriveRunActivity(
      wire(
        [
          item({ kind: "tool", action: "a", turnId: "old", status: "running" }),
          item({ kind: "tool", action: "b", turnId: "new", status: "running" }),
        ],
        { live: { turnInFlight: true, since: new Date(), lastAt: null } }
      )
    );
    expect(v.now?.step?.action).toBe("b");
    expect(v.groups.map((g) => g.phase)).toEqual(["unsettled"]);
  });

  it("is omitted on a terminal session (the run folds into its result)", () => {
    const v = deriveRunActivity(wire([item({})], { terminal: true }));
    expect(v.now).toBeNull();
  });
});

describe("waiting on you — rendered once", () => {
  it("a pending decision is in `waiting` and NOT also in history", () => {
    const pending = item({
      kind: "decision",
      status: "pending",
      action: "create",
      objectKind: "task",
      objectTitle: "Launch",
      proposalId: "p1",
    });
    const v = deriveRunActivity(wire([item({}), pending]));
    expect(v.waiting.map((s) => s.id)).toEqual([pending.id]);
    expect(v.groups.flatMap((g) => g.steps).map((s) => s.id)).not.toContain(
      pending.id
    );
    // Imperative: what approving it WILL do.
    expect(v.waiting[0]?.label).toBe('Create Task "Launch"');
  });

  it("a decided decision is history, in the PAST mood; a rejected one is declined", () => {
    const v = deriveRunActivity(
      wire([
        item({
          kind: "decision",
          status: "approved",
          action: "create",
          objectKind: "task",
          objectTitle: "A",
        }),
        item({
          kind: "decision",
          status: "rejected",
          action: "create",
          objectKind: "task",
          objectTitle: "B",
        }),
      ])
    );
    expect(v.groups.map((g) => g.label)).toEqual([
      'Created Task "A"',
      'Rejected: Create Task "B"',
    ]);
    expect(v.groups[1]?.phase).toBe("declined");
    expect(v.summary).toMatchObject({ approved: 1, rejected: 1 });
  });
});

describe("grouping", () => {
  it("collapses consecutive same-verb same-kind writes", () => {
    const v = deriveRunActivity(wire([item({}), item({}), item({})]));
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]?.label).toBe("Created 3 tasks");
    expect(v.groups[0]?.steps).toHaveLength(3);
  });

  it("never groups ACROSS a decision", () => {
    const v = deriveRunActivity(
      wire([
        item({}),
        item({
          kind: "decision",
          status: "approved",
          action: "update",
          objectKind: "task",
        }),
        item({}),
      ])
    );
    expect(v.groups.map((g) => g.steps.length)).toEqual([1, 1, 1]);
  });

  it("never groups tool steps across a turn boundary", () => {
    const v = deriveRunActivity(
      wire([
        item({
          kind: "tool",
          action: "search_unified",
          turnId: "t1",
          title: "Searching",
        }),
        item({
          kind: "tool",
          action: "search_unified",
          turnId: "t2",
          title: "Searching",
        }),
        item({
          kind: "tool",
          action: "search_unified",
          turnId: "t2",
          title: "Searching",
        }),
      ])
    );
    expect(v.groups.map((g) => g.label)).toEqual([
      "Searching",
      "Searching · 2",
    ]);
  });

  it("never folds a failure into a run of successes", () => {
    const v = deriveRunActivity(
      wire([
        item({ kind: "tool", action: "x", turnId: "t", title: "X" }),
        item({
          kind: "tool",
          action: "x",
          turnId: "t",
          status: "failed",
          error: "SMTP not connected",
        }),
        item({ kind: "tool", action: "x", turnId: "t", title: "X" }),
      ])
    );
    expect(v.groups.map((g) => g.phase)).toEqual(["done", "failed", "done"]);
    expect(v.summary.failed).toBe(1);
  });
});

describe("EMPTY vs FAILED", () => {
  it("an unreadable source is partial, NOT empty", () => {
    const v = deriveRunActivity(wire([], { unreadable: ["events"] }));
    expect(v.empty).toBe(false);
    expect(v.unreadable).toEqual(["events"]);
  });

  it("nothing at all and everything readable is the only honest empty", () => {
    expect(deriveRunActivity(wire([])).empty).toBe(true);
  });
});

describe("labels never leak a raw token", () => {
  it("an unknown tool with no prose humanizes", () => {
    const v = deriveRunActivity(
      wire([
        item({
          kind: "tool",
          action: "graph_traverse_v2",
          turnId: "t",
          title: null,
        }),
      ])
    );
    expect(v.groups[0]?.label).toBe("Graph traverse v2");
  });

  it("a failed tool reads its error line, never the tool token", () => {
    const v = deriveRunActivity(
      wire([
        item({
          kind: "error",
          status: "failed",
          action: "send_email",
          error: "SMTP not connected",
        }),
      ])
    );
    expect(v.groups[0]?.label).toBe("SMTP not connected");
  });
});

describe("marks", () => {
  it("a failure is never the AI tone; only the live step wears it", () => {
    expect(stepMark("failed").tone).toBe("error");
    expect(STEP_PHASES.filter((p) => stepMark(p).tone === "ai")).toEqual([
      "now",
    ]);
  });

  it("waiting on you wears the same mark as a run waiting on you", () => {
    expect(stepMark("waiting_on_you")).toEqual({
      tone: "primary",
      glyph: "person",
    });
  });
});

describe("summary + cap", () => {
  it("counts steps without the lifecycle bookends; duration spans first → last", () => {
    const v = deriveRunActivity(
      wire([
        item({
          kind: "lifecycle",
          action: "create",
          objectKind: "session",
          at: "2026-10-04T12:00:00.000Z",
        }),
        item({ at: "2026-10-04T12:04:00.000Z" }),
      ])
    );
    expect(v.summary.steps).toBe(1);
    expect(v.summary.durationMs).toBe(4 * 60_000);
  });

  it("caps to the NEWEST groups and reports how many were held back", () => {
    const groups = Array.from({ length: ACTIVITY_HISTORY_CAP + 3 }, (_, i) => ({
      id: `g${i}`,
      kind: "note" as const,
      phase: "done" as const,
      label: `n${i}`,
      steps: [],
      at: new Date(i),
    }));
    const { shown, hidden } = capActivityGroups(groups);
    expect(hidden).toBe(3);
    expect(shown[0]?.id).toBe("g3");
    expect(shown[shown.length - 1]?.id).toBe(`g${ACTIVITY_HISTORY_CAP + 2}`);
  });
});
