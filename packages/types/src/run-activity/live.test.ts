/**
 * D1 — "working right now" = an IS turn in flight OR activity inside
 * `SESSION_WORKING_WINDOW_MS`. Fixtures sit where the plausible wrong rules
 * DISAGREE (guards-and-tests.md):
 *   - "open lifecycle = working"  (the old header rule)  → ruled out by STALE OPEN
 *   - "turn in flight only"       (the old Now line rule) → ruled out by 4m59
 *   - "any activity ever"         / an off-by-window      → ruled out by 5m01
 * and the AGREEMENT test drives the header mark (`sessionUnitInput` →
 * `resolveUnitState`) and the Now line (`deriveRunActivity`) off ONE wire and
 * asserts they never contradict each other.
 */

import { describe, expect, it } from "vitest";
import {
  deriveRunActivity,
  isSessionWorkingNow,
  SESSION_WORKING_WINDOW_MS,
  workingFlipInMs,
  type SessionActivityItem,
  type SessionActivityWire,
} from "./index.js";
import { resolveUnitState, sessionUnitInput } from "../units/index.js";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms);
const M = 60_000;

function item(over: Partial<SessionActivityItem>): SessionActivityItem {
  return {
    id: over.id ?? "i1",
    at: ago(4 * M + 59_000),
    kind: "write",
    status: "done",
    turnId: null,
    action: "create",
    objectKind: "task",
    objectId: "o1",
    objectTitle: "Draft the brief",
    title: null,
    error: null,
    proposalId: null,
    actor: null,
    ...over,
  };
}

function wire(
  lastAgoMs: number | null,
  over: Partial<SessionActivityWire> = {}
): SessionActivityWire {
  const at = lastAgoMs === null ? null : ago(lastAgoMs);
  return {
    sessionId: "s1",
    items: at ? [item({ at })] : [],
    truncated: false,
    terminal: false,
    live: { turnInFlight: false, since: null, lastAt: at },
    unreadable: [],
    ...over,
  };
}

describe("isSessionWorkingNow — the ONE rule", () => {
  it("is exactly five minutes", () => {
    expect(SESSION_WORKING_WINDOW_MS).toBe(5 * M);
  });
  it("a turn in flight is working, however old the last step", () => {
    expect(
      isSessionWorkingNow({ turnInFlight: true, lastAt: ago(3 * 60 * M) }, NOW)
    ).toBe(true);
  });
  it("activity 4m59 ago is working (rules out 'turn in flight only')", () => {
    expect(
      isSessionWorkingNow(
        { turnInFlight: false, lastAt: ago(4 * M + 59_000) },
        NOW
      )
    ).toBe(true);
  });
  it("activity 5m01 ago is NOT working (rules out 'any activity' / a wider window)", () => {
    expect(
      isSessionWorkingNow(
        { turnInFlight: false, lastAt: ago(5 * M + 1_000) },
        NOW
      )
    ).toBe(false);
  });
  it("nothing recorded, or no facts at all, is not working", () => {
    expect(
      isSessionWorkingNow({ turnInFlight: false, lastAt: null }, NOW)
    ).toBe(false);
    expect(isSessionWorkingNow(null, NOW)).toBe(false);
  });
  it("an ISO string reads the same as a Date (superjson vs plain JSON)", () => {
    expect(
      isSessionWorkingNow(
        { turnInFlight: false, lastAt: ago(M).toISOString() },
        NOW
      )
    ).toBe(true);
  });
});

describe("workingFlipInMs — when a surface must re-render with no new data", () => {
  it("counts down to the window's end", () => {
    expect(
      workingFlipInMs({ turnInFlight: false, lastAt: ago(4 * M) }, NOW)
    ).toBe(M + 1);
  });
  it("never flips on its own while a turn is in flight, or once quiet", () => {
    expect(
      workingFlipInMs({ turnInFlight: true, lastAt: ago(M) }, NOW)
    ).toBeNull();
    expect(
      workingFlipInMs({ turnInFlight: false, lastAt: ago(6 * M) }, NOW)
    ).toBeNull();
  });
});

describe("the Now line under D1", () => {
  it("4m59 with no turn in flight: mode 'now', naming the latest step", () => {
    const v = deriveRunActivity(wire(4 * M + 59_000), { now: NOW });
    expect(v.workingNow).toBe(true);
    expect(v.now?.mode).toBe("now");
    expect(v.now?.label).toBe('Created Task "Draft the brief"');
  });
  it("5m01: mode 'last' — never 'now'", () => {
    const v = deriveRunActivity(wire(5 * M + 1_000), { now: NOW });
    expect(v.workingNow).toBe(false);
    expect(v.now?.mode).toBe("last");
  });
  it("stale open session (hours quiet): 'last'", () => {
    const v = deriveRunActivity(wire(3 * 60 * M), { now: NOW });
    expect(v.now?.mode).toBe("last");
  });
  it("something owed outranks recent activity: the line says what waits on you", () => {
    const w = wire(M);
    w.items.push(
      item({ id: "d1", kind: "decision", status: "pending", at: ago(M) })
    );
    const v = deriveRunActivity(w, { now: NOW });
    expect(v.now?.mode).toBe("waiting");
  });
  it("a terminal session is never working, however recent", () => {
    const v = deriveRunActivity(wire(M, { terminal: true }), { now: NOW });
    expect(v.workingNow).toBe(false);
    expect(v.now).toBeNull();
  });
});

describe("the header mark under D1 (`sessionUnitInput`)", () => {
  const mark = (live: Parameters<typeof sessionUnitInput>[0]["live"]) =>
    resolveUnitState(
      sessionUnitInput({
        status: "active",
        owedFromYou: 0,
        pendingDecisions: 0,
        live,
        now: NOW,
      })
    ).state;

  it("stale open session reads the quiet state `paused` — never `working` (rules out 'open = working')", () => {
    expect(mark({ turnInFlight: false, lastAt: ago(3 * 60 * M) })).toBe(
      "paused"
    );
  });
  it("4m59 → working; 5m01 → paused", () => {
    expect(mark({ turnInFlight: false, lastAt: ago(4 * M + 59_000) })).toBe(
      "working"
    );
    expect(mark({ turnInFlight: false, lastAt: ago(5 * M + 1_000) })).toBe(
      "paused"
    );
  });
  it("a turn in flight → working", () => {
    expect(mark({ turnInFlight: true, lastAt: null })).toBe("working");
  });
  it("a FAILED liveness read claims neither: unmeasured", () => {
    expect(mark(null)).toBe("unmeasured");
  });
  it("no liveness passed (older pod) keeps the lifecycle reading", () => {
    expect(mark(undefined)).toBe("working");
  });
  it("needs-you still outranks quiet", () => {
    expect(
      resolveUnitState(
        sessionUnitInput({
          status: "active",
          owedFromYou: 2,
          live: { turnInFlight: false, lastAt: ago(3 * 60 * M) },
          now: NOW,
        })
      ).state
    ).toBe("needs_you");
  });
});

describe("AGREEMENT — the header mark and the Now line never contradict", () => {
  // Every fixture where a wrong rule on EITHER side would split them.
  const cases: Array<[string, SessionActivityWire]> = [
    [
      "turn in flight, last step hours ago",
      wire(3 * 60 * M, {
        live: {
          turnInFlight: true,
          since: ago(10_000),
          lastAt: ago(3 * 60 * M),
        },
      }),
    ],
    ["4m59", wire(4 * M + 59_000)],
    ["5m01", wire(5 * M + 1_000)],
    ["stale open", wire(3 * 60 * M)],
    ["never active", wire(null)],
  ];
  for (const [name, w] of cases) {
    it(name, () => {
      const line = deriveRunActivity(w, { now: NOW });
      const header = resolveUnitState(
        sessionUnitInput({
          status: "active",
          owedFromYou: 0,
          pendingDecisions: 0,
          live: w.live,
          now: NOW,
        })
      ).state;
      // The mark says working ⇔ the line is live.
      expect(header === "working").toBe(line.workingNow);
      if (line.now) expect(line.now.mode === "now").toBe(header === "working");
    });
  }
});
