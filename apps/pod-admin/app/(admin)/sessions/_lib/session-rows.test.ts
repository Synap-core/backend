import { describe, expect, it } from "vitest";
import {
  CLOSED_STATUSES,
  IDLE_STATUSES,
  OPEN_RUN_STATUSES,
  STUCK_AFTER_HOURS,
  isStuck,
  segmentOf,
  sessionActs,
  sessionPill,
  sessionRow,
  splitOpen,
  waitingRows,
  whereOf,
  type Names,
  type SessionLike,
} from "./session-rows";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const H = 3_600_000;

function session(over: Partial<SessionLike> = {}): SessionLike {
  return {
    id: "s1",
    title: "Weekly digest",
    goal: "Write the digest",
    status: "active",
    startedAt: new Date(NOW - 2 * H),
    updatedAt: new Date(NOW - H),
    closedAt: null,
    workspaceId: "w1",
    projectId: null,
    userId: "u1",
    viewerRole: "owner",
    live: { turnInFlight: false, lastAt: new Date(NOW - H) },
    ...over,
  };
}

const NAMES: Names = {
  workspaces: new Map([["w1", "Builder"]]),
  projects: new Map([["p1", "Launch"]]),
  people: new Map([["u2", "Ada"]]),
};

describe("segmentOf", () => {
  it("defaults to running and accepts every known segment", () => {
    expect(segmentOf(null)).toBe("running");
    expect(segmentOf("nonsense")).toBe("running");
    expect(segmentOf("stuck")).toBe("stuck");
    expect(segmentOf("waiting")).toBe("waiting");
    expect(segmentOf("idle")).toBe("idle");
    expect(segmentOf("closed")).toBe("closed");
  });
});

describe("isStuck — diagnose's 24h boundary, minus the provably alive", () => {
  const old = new Date(NOW - (STUCK_AFTER_HOURS + 1) * H);

  it("an open session past the boundary with no recent activity is stuck", () => {
    expect(isStuck(session({ startedAt: old }), NOW)).toBe(true);
  });

  it("a young session is not stuck, however quiet", () => {
    expect(
      isStuck(session({ live: { turnInFlight: false, lastAt: null } }), NOW)
    ).toBe(false);
  });

  it("an old session an agent is working on right now is not stuck", () => {
    expect(
      isStuck(
        session({
          startedAt: old,
          live: { turnInFlight: true, lastAt: null },
        }),
        NOW
      )
    ).toBe(false);
    expect(
      isStuck(
        session({
          startedAt: old,
          live: { turnInFlight: false, lastAt: new Date(NOW - 60_000) },
        }),
        NOW
      )
    ).toBe(false);
  });

  it("a failed liveness read leaves age to decide", () => {
    expect(isStuck(session({ startedAt: old, live: null }), NOW)).toBe(true);
  });

  it("paused and terminal sessions are never stuck", () => {
    expect(isStuck(session({ startedAt: old, status: "paused" }), NOW)).toBe(
      false
    );
    expect(isStuck(session({ startedAt: old, status: "closed" }), NOW)).toBe(
      false
    );
    expect(isStuck(session({ startedAt: old, status: "stale" }), NOW)).toBe(
      false
    );
  });

  it("splitOpen partitions one page without losing a row", () => {
    const rows = [
      session({ id: "a" }),
      session({ id: "b", startedAt: old }),
      session({ id: "c", status: "paused", startedAt: old }),
    ];
    const { running, stuck } = splitOpen(rows, NOW);
    expect(running.map((r) => r.id)).toEqual(["a", "c"]);
    expect(stuck.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("sessionActs — owner only, one primary", () => {
  it("a member gets no acts", () => {
    expect(sessionActs("active", "running", "member")).toEqual({
      primary: null,
      secondary: null,
    });
  });

  it("running: pause or resume first, close second", () => {
    expect(sessionActs("active", "running", "owner")).toEqual({
      primary: "pause",
      secondary: "close",
    });
    expect(sessionActs("paused", "running", "owner")).toEqual({
      primary: "resume",
      secondary: "close",
    });
  });

  it("stuck and idle lead with close", () => {
    expect(sessionActs("active", "stuck", "owner")).toEqual({
      primary: "close",
      secondary: "pause",
    });
    expect(sessionActs("stale", "idle", "owner")).toEqual({
      primary: "close",
      secondary: "resume",
    });
  });

  it("a terminal or scheduled session has nothing to do from a list", () => {
    for (const status of ["closed", "failed", "cancelled", "scheduled"]) {
      expect(sessionActs(status, "closed", "owner").primary).toBeNull();
    }
  });
});

describe("sessionPill", () => {
  it("prefers the criteria verdict when the session declares criteria", () => {
    expect(
      sessionPill(
        session({ verdict: { state: "passing", total: 2, passed: 2 } }),
        NOW
      )
    ).toEqual({ kind: "healthy", label: "Criteria met" });
    expect(
      sessionPill(
        session({ verdict: { state: "failing", total: 2, passed: 1 } }),
        NOW
      )?.kind
    ).toBe("down");
    expect(
      sessionPill(
        session({ verdict: { state: "incomplete", total: 3, passed: 1 } }),
        NOW
      )
    ).toEqual({ kind: "stale", label: "1/3 criteria" });
  });

  it("says Working when an agent is on it now, else the lifecycle word", () => {
    expect(
      sessionPill(session({ live: { turnInFlight: true, lastAt: null } }), NOW)
    ).toEqual({ kind: "healthy", label: "Working" });
    expect(sessionPill(session({ status: "paused" }), NOW)?.label).toBeTruthy();
  });
});

describe("rows", () => {
  it("whereOf names the space and project it can", () => {
    expect(whereOf({ workspaceId: "w1", projectId: "p1" }, NAMES)).toBe(
      "Builder › Launch"
    );
    expect(whereOf({ workspaceId: "w1", projectId: null }, NAMES)).toBe(
      "Builder"
    );
    expect(whereOf({ workspaceId: "nope", projectId: null }, NAMES)).toBeNull();
  });

  it("a shared session says so, and has no acts", () => {
    const row = sessionRow(
      session({ viewerRole: "member", userId: "u2" }),
      "running",
      NAMES,
      NOW
    );
    expect(row.secondary).toContain("Ada’s, shared with you");
    expect(row.acts.primary).toBeNull();
  });

  it("falls back to the goal, then to a plain name", () => {
    expect(
      sessionRow(session({ title: null }), "running", NAMES, NOW).title
    ).toBe("Write the digest");
    expect(
      sessionRow(session({ title: null, goal: "" }), "running", NAMES, NOW)
        .title
    ).toBe("Untitled session");
  });

  it("waitingRows groups owed slots per session, oldest first", () => {
    const rows = waitingRows(
      [
        {
          sessionId: "a",
          sessionTitle: "Research",
          sessionStatus: "active",
          workspaceId: "w1",
          projectId: null,
          label: "Pick a vendor",
          owedSince: new Date(NOW - 5 * H).toISOString(),
        },
        {
          sessionId: "b",
          sessionTitle: null,
          sessionStatus: "closed",
          workspaceId: null,
          projectId: null,
          label: "Sign off",
          owedSince: new Date(NOW - 4 * H).toISOString(),
        },
        {
          sessionId: "a",
          sessionTitle: "Research",
          sessionStatus: "active",
          workspaceId: "w1",
          projectId: null,
          label: "Approve budget",
          owedSince: new Date(NOW - 3 * H).toISOString(),
        },
      ],
      NAMES
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]!.pill).toEqual({ kind: "stale", label: "2 owed" });
    expect(rows[0]!.secondary).toContain("Builder");
    expect(rows[0]!.acts.primary).toBe("pause");
    // An owed slot outlives its session; a closed one offers no act.
    expect(rows[1]!.title).toBe("Untitled session");
    expect(rows[1]!.acts.primary).toBeNull();
  });
});

describe("segment status sets", () => {
  it("read every stored status exactly once, scheduled aside", () => {
    expect([...OPEN_RUN_STATUSES].sort()).toEqual([
      "active",
      "forming",
      "paused",
    ]);
    expect([...IDLE_STATUSES]).toEqual(["stale"]);
    expect([...CLOSED_STATUSES].sort()).toEqual([
      "cancelled",
      "closed",
      "failed",
    ]);
  });
});
