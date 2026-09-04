/**
 * TRIAGE — the derivation, the two lenses, and the decision doors.
 *
 * The thing worth pinning here is that the SQL predicate and the TypeScript
 * projection agree, because they are two spellings of one rule and a drift
 * between them shows up as "the badge says pending but the lens does not list
 * it". The pure half is asserted directly; the doors are asserted through a
 * chainable db stub (same shape `session-blocked-by.test.ts` uses) for what a
 * caller actually depends on: WHETHER a write happened and what came back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { state, calls, dbStub } = vi.hoisted(() => {
  const state: { session: unknown } = { session: null };
  const calls: Array<{ method: string; args: unknown[] }> = [];

  function chain(): Record<string, unknown> {
    const node: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown) {
        // Every `.returning()` resolves to the row the test staged, with the
        // staged patch applied — enough to assert the door's own result.
        return Promise.resolve([state.session]).then(resolve);
      },
    };
    for (const m of ["set", "where", "returning", "select", "from", "limit"]) {
      node[m] = (...args: unknown[]) => {
        calls.push({ method: m, args });
        return node;
      };
    }
    return node;
  }
  const shared = chain();
  const dbStub = {
    query: {
      focusSessions: {
        findFirst: async () => state.session,
      },
    },
    update: (...a: unknown[]) => {
      calls.push({ method: "update", args: a });
      return shared;
    },
    select: (...a: unknown[]) => {
      calls.push({ method: "select", args: a });
      return shared;
    },
  };
  return { state, calls, dbStub };
});

// PARTIAL mock — a total replacement goes dark at COLLECTION time the moment
// the module under test imports one more export.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: dbStub };
});
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: vi.fn(async () => "event-id"),
}));
vi.mock("../complete-session.js", () => ({
  completeFocusSession: vi.fn(
    async (p: { sessionId: string; terminalStatus?: string }) => ({
      session: { ...AGENT_SESSION, status: p.terminalStatus ?? "closed" },
      pendingProposals: [],
      counts: { pending: 0, unfinishedOutputs: 0, expiredEphemerals: 3 },
      warnings: [],
    })
  ),
}));

import {
  projectTriage,
  attachTriage,
  triagePendingWhere,
  notTriagePendingWhere,
  acceptFromTriage,
  discardFromTriage,
} from "../triage.js";
import { completeFocusSession } from "../complete-session.js";

const AGENT_SESSION = {
  id: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  workspaceId: "ws-1",
  projectId: null,
  goal: "Draft the Q3 brief",
  origin: "agent",
  status: "active",
  metadata: {},
};

beforeEach(() => {
  calls.length = 0;
  state.session = { ...AGENT_SESSION };
});

describe("projectTriage — the derivation", () => {
  it("is pending for an unaccepted agent/automation session that is still open", () => {
    expect(projectTriage(AGENT_SESSION).pending).toBe(true);
    expect(
      projectTriage({ ...AGENT_SESSION, origin: "automation" }).pending
    ).toBe(true);
  });

  it("is NOT pending for a session the person started themselves", () => {
    // The whole point of the `human` origin: before it existed every
    // human-started session was stamped `agent` and the lens could not tell.
    expect(projectTriage({ ...AGENT_SESSION, origin: "human" }).pending).toBe(
      false
    );
    expect(
      projectTriage({ ...AGENT_SESSION, origin: "playbook" }).pending
    ).toBe(false);
  });

  it("is NOT pending once accepted, and reports who accepted it", () => {
    const accepted = projectTriage({
      ...AGENT_SESSION,
      metadata: {
        triage: { acceptedAt: "2026-09-04T10:00:00Z", acceptedBy: "user-1" },
      },
    });
    expect(accepted.pending).toBe(false);
    expect(accepted.acceptedAt).toBe("2026-09-04T10:00:00Z");
    expect(accepted.acceptedBy).toBe("user-1");
  });

  it("is NOT pending for a closed or cancelled session", () => {
    expect(projectTriage({ ...AGENT_SESSION, status: "closed" }).pending).toBe(
      false
    );
    expect(
      projectTriage({ ...AGENT_SESSION, status: "cancelled" }).pending
    ).toBe(false);
  });

  it("keeps an unclassified (NULL origin) session OUT of triage", () => {
    // It must land in the DEFAULT lens instead — a legacy row is not a
    // suggestion, and vanishing from both lenses is the failure to avoid.
    expect(projectTriage({ ...AGENT_SESSION, origin: null }).pending).toBe(
      false
    );
  });

  it("attaches the projection to a page without querying anything", () => {
    const rows = attachTriage([
      AGENT_SESSION,
      { ...AGENT_SESSION, origin: "human" },
    ]);
    expect(rows.map((r) => r.triage.pending)).toEqual([true, false]);
    expect(calls).toHaveLength(0);
  });
});

/** Collect the literal SQL text out of a drizzle chunk tree. */
function sqlText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  const n = node as { value?: unknown; queryChunks?: unknown[] };
  if (Array.isArray(n.value)) return n.value.map(sqlText).join("");
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(sqlText).join(" ");
  return "";
}

describe("the two lenses", () => {
  it("keys BOTH on the same jsonb receipt path, in opposite senses", () => {
    // The path is the contract between the SQL lens and `projectTriage`. If one
    // moved, the badge and the list would disagree — this pins them together.
    const pending = sqlText(triagePendingWhere());
    const notPending = sqlText(notTriagePendingWhere());
    expect(pending).toContain("{triage,acceptedAt}");
    expect(pending).toContain("IS NULL");
    expect(pending).not.toContain("IS NOT NULL");
    expect(notPending).toContain("{triage,acceptedAt}");
    expect(notPending).toContain("IS NOT NULL");
  });
});

describe("acceptFromTriage", () => {
  it("stamps the receipt and does NOT touch status", async () => {
    const result = await acceptFromTriage({
      sessionId: AGENT_SESSION.id,
      userId: "user-1",
    });
    expect(result.ok).toBe(true);
    const setCall = calls.find((c) => c.method === "set");
    expect(setCall).toBeTruthy();
    const patch = setCall!.args[0] as Record<string, unknown>;
    // A triage session is still active/forming/scheduled — one column cannot
    // hold both "in flight" and "not yet accepted".
    expect(patch).not.toHaveProperty("status");
    expect(patch).toHaveProperty("metadata");
  });

  it("refuses a session that is not in triage — a fact, not a fault", async () => {
    state.session = { ...AGENT_SESSION, origin: "human" };
    const result = await acceptFromTriage({
      sessionId: AGENT_SESSION.id,
      userId: "user-1",
    });
    expect(result).toEqual({ ok: false, reason: "not_pending" });
    expect(calls.some((c) => c.method === "update")).toBe(false);
  });

  it("reports not_found rather than writing when the owner floor rejects", async () => {
    state.session = null;
    const result = await acceptFromTriage({
      sessionId: AGENT_SESSION.id,
      userId: "someone-else",
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(calls.some((c) => c.method === "update")).toBe(false);
  });
});

describe("discardFromTriage", () => {
  it("exits through the ONE close door as cancelled, and reports the retired ephemerals", async () => {
    const result = await discardFromTriage({
      sessionId: AGENT_SESSION.id,
      userId: "user-1",
    });
    expect(result.ok).toBe(true);
    // Discard is a terminal exit like any other: the close door owns the
    // status flip, the run close, the ephemeral expiry and the close event.
    expect(completeFocusSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: AGENT_SESSION.id,
        userId: "user-1",
        terminalStatus: "cancelled",
      })
    );
    const patch = calls.find((c) => c.method === "set")!.args[0] as Record<
      string,
      unknown
    >;
    // Only the triage receipt is stamped locally — never a second status write.
    expect(patch.status).toBeUndefined();
    expect(result.ok && result.expiredEphemerals).toBe(3);
  });

  it("refuses a session that is not in triage", async () => {
    state.session = { ...AGENT_SESSION, status: "closed" };
    const result = await discardFromTriage({
      sessionId: AGENT_SESSION.id,
      userId: "user-1",
    });
    expect(result).toEqual({ ok: false, reason: "not_pending" });
  });
});
