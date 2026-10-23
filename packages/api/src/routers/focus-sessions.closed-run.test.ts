/**
 * A CLOSED RUN STAYS CLOSED (work model R8) — at both update doors.
 *
 * Before W2 the tRPC `focusSessions.update` funnel handled only terminal
 * TARGETS, and `updateFocusSession` (the MCP door's service) had no status
 * check at all: a closed session could be set straight back to `active`. Both
 * now ask `closedRunRefusal` (`@synap-core/types/focus-sessions`) right after
 * the row is loaded. These drive the REAL tRPC procedure and the REAL service
 * and read what reaches the write: nothing.
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables and operators
 * kept, connection replaced) — the harness of `focus-sessions.update-outputs.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";

const findFirstSpy = vi.fn();
const sets: Record<string, unknown>[] = [];

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      insert: () => {
        const chain: Record<string, unknown> = {
          values: () => chain,
          onConflictDoNothing: () => chain,
          onConflictDoUpdate: () => chain,
          returning: async () => [],
          then: (resolve: (v: unknown) => void) => resolve([]),
        };
        return chain;
      },
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          sets.push(patch);
          return {
            where: () => ({
              returning: async () => [{ id: SESSION, ...patch }],
            }),
          };
        },
      }),
      query: new Proxy({} as Record<string, unknown>, {
        get: (_t, table) => {
          if (table === "focusSessions") return { findFirst: findFirstSpy };
          return { findFirst: async () => undefined };
        },
      }),
    },
  };
});

vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));

const { focusSessionsRouter } = await import("./focus-sessions.js");
const { updateFocusSession } =
  await import("../services/focus-sessions/update-session.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => focusSessionsRouter.createCaller(ctx);

function stored(status: string) {
  return {
    id: SESSION,
    userId: "user-1",
    workspaceId: WS,
    goal: "Ship the thing",
    status,
    currentStage: null,
    expectedOutputs: [],
    criteria: [],
    agentIds: [],
    metadata: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sets.length = 0;
});

describe("tRPC focusSessions.update — a closed run stays closed", () => {
  for (const from of ["closed", "cancelled", "failed"]) {
    it(`refuses ${from} → active, and writes nothing`, async () => {
      findFirstSpy.mockResolvedValue(stored(from));
      await expect(
        caller().update({ id: SESSION, status: "active" })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/a closed run stays closed/),
      });
      expect(sets).toEqual([]);
    });
  }

  it("an OPEN run still moves (the refusal is not every status write)", async () => {
    findFirstSpy.mockResolvedValue(stored("active"));
    await caller().update({ id: SESSION, status: "paused" });
    expect(sets.at(-1)).toMatchObject({ status: "paused" });
  });
});

describe("updateFocusSession (MCP / Hub service door) — a closed run stays closed", () => {
  it("refuses closed → active with the reason, before any floor or write", async () => {
    findFirstSpy.mockResolvedValue(stored("closed"));
    const res = await updateFocusSession({
      sessionId: SESSION,
      userId: "user-1",
      agentUserId: "agent-1",
      status: "active",
    });
    expect(res).toMatchObject({
      status: "denied",
      reason: expect.stringMatching(/a closed run stays closed/),
    });
    expect(sets).toEqual([]);
  });

  it("refuses closed → paused too", async () => {
    findFirstSpy.mockResolvedValue(stored("failed"));
    const res = await updateFocusSession({
      sessionId: SESSION,
      userId: "user-1",
      status: "paused",
    });
    expect(res).toMatchObject({ status: "denied" });
  });
});
