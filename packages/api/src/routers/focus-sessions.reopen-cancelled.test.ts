/**
 * A PERSON REOPENS A CANCELLED RUN; an agent never does (founder,
 * 2026-11-04, decision 3da00cda, finding 8748feab).
 *
 * Drives the REAL tRPC `focusSessions.update` procedure, the REAL MCP/Hub
 * service `updateFocusSession` and the REAL reopen door
 * (`services/focus-sessions/reopen-session.ts`), and reads what reaches the
 * writes: the status move (`setSessionStatus`), the run row, the room line.
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables and operators
 * kept, connection and the status write replaced), as in
 * `focus-sessions.closed-run.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";

const findFirstSpy = vi.fn();
const statusMoves: Array<Record<string, unknown>> = [];
const rowWrites: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
const posted: Array<Record<string, unknown>> = [];
const world: {
  locked: { status: string; expectedOutputs: unknown[] } | null;
  liveRun: { id: string } | null;
  latestRun: { id: string; status: string } | null;
} = { locked: null, liveRun: null, latestRun: null };

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // One select chain: answers by the table it was asked of.
  const select = () => {
    let table: unknown;
    let ordered = false;
    const result = () => {
      if (table === actual.focusSessions)
        return world.locked ? [world.locked] : [];
      if (table === actual.playbookRuns) {
        if (ordered) return world.latestRun ? [world.latestRun] : [];
        return world.liveRun ? [world.liveRun] : [];
      }
      if (table === actual.users) return [{ name: "Ada" }];
      return [];
    };
    const chain: Record<string, unknown> = {
      from: (t: unknown) => ((table = t), chain),
      where: () => chain,
      orderBy: () => ((ordered = true), chain),
      limit: () => chain,
      for: () => chain,
      then: (resolve: (v: unknown) => void) => resolve(result()),
    };
    return chain;
  };
  const update = (table: unknown) => ({
    set: (patch: Record<string, unknown>) => {
      rowWrites.push({ table, patch });
      const done = {
        returning: async () => [{ id: SESSION, ...patch }],
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return { where: () => done };
    },
  });
  const insert = () => {
    const chain: Record<string, unknown> = {
      values: () => chain,
      onConflictDoNothing: () => chain,
      onConflictDoUpdate: () => chain,
      returning: async () => [],
      then: (resolve: (v: unknown) => void) => resolve([]),
    };
    return chain;
  };
  const tx = { select, update, insert };
  return {
    ...actual,
    setSessionStatus: async (_tx: unknown, input: Record<string, unknown>) => {
      statusMoves.push(input);
      return {
        rows: [
          {
            ...stored("cancelled"),
            ...(input.set as Record<string, unknown>),
            status: input.to,
          },
        ],
        transitions: [],
      };
    },
    writeSessionPatch: async (
      _db: unknown,
      input: { set: Record<string, unknown> }
    ) => {
      rowWrites.push({ table: actual.focusSessions, patch: input.set });
      return [{ ...stored("active"), ...input.set }];
    },
    db: {
      select,
      update,
      insert,
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
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
vi.mock("../services/messaging/post-message.js", () => ({
  postChannelMessage: async (p: Record<string, unknown>) => {
    posted.push(p);
    return { id: "m1" };
  },
}));

const { focusSessionsRouter } = await import("./focus-sessions.js");
const { updateFocusSession } =
  await import("../services/focus-sessions/update-session.js");
const { playbookRuns, focusSessions } = await import("@synap/database");

const person = () =>
  focusSessionsRouter.createCaller({
    userId: "user-1",
    authenticated: true,
  } as never);
const agent = () =>
  focusSessionsRouter.createCaller({
    userId: "user-1",
    agentUserId: "agent-1",
    authenticated: true,
  } as never);

function stored(status: string) {
  return {
    id: SESSION,
    userId: "user-1",
    workspaceId: WS,
    goal: "Ship the thing",
    status,
    channelId: ROOM,
    currentStage: null,
    expectedOutputs: [],
    criteria: [],
    agentIds: [],
    metadata: {},
  };
}

const retiredByCancel = {
  kind: "decision",
  label: "Pick the vendor",
  owner: "human",
  status: "pending",
  retiredAt: "2026-11-03T14:00:00.000Z",
  retiredReason: "session_cancelled",
};
const withdrawnEarlier = {
  kind: "document",
  label: "Old brief",
  owner: "human",
  status: "pending",
  retiredAt: "2026-11-01T10:00:00.000Z",
  retiredReason: "withdrawn",
};

beforeEach(() => {
  vi.clearAllMocks();
  statusMoves.length = 0;
  rowWrites.length = 0;
  posted.length = 0;
  world.locked = {
    status: "cancelled",
    expectedOutputs: [retiredByCancel, withdrawnEarlier],
  };
  world.liveRun = null;
  world.latestRun = { id: RUN, status: "cancelled" };
});

describe("tRPC focusSessions.update — a PERSON reopens a cancelled session", () => {
  it("moves it cancelled → active through the one status write, closedAt cleared", async () => {
    findFirstSpy.mockResolvedValue(stored("cancelled"));
    await person().update({ id: SESSION, status: "active" });

    expect(statusMoves).toHaveLength(1);
    const move = statusMoves[0]!;
    expect(move).toMatchObject({
      sessionId: SESSION,
      from: "cancelled",
      to: "active",
      actor: { kind: "human", userId: "user-1" },
    });
    const set = move.set as Record<string, unknown>;
    expect(set.closedAt).toBeNull();
    // The slot the cancel retired is owed again; one withdrawn earlier is not.
    const outputs = set.expectedOutputs as Array<Record<string, unknown>>;
    expect(outputs[0]).not.toHaveProperty("retiredAt");
    expect(outputs[0]).not.toHaveProperty("retiredReason");
    expect(outputs[1]).toMatchObject({ retiredReason: "withdrawn" });
    // No second session status write behind the door's back.
    const sessionWrites = rowWrites.filter((w) => w.table === focusSessions);
    expect(sessionWrites.length).toBeGreaterThan(0);
    expect(sessionWrites.some((w) => "status" in w.patch)).toBe(false);
  });

  it("runs the playbook run the cancel ended again", async () => {
    findFirstSpy.mockResolvedValue(stored("cancelled"));
    await person().update({ id: SESSION, status: "active" });
    const runWrite = rowWrites.find((w) => w.table === playbookRuns);
    expect(runWrite?.patch).toEqual({
      status: "running",
      completedAt: null,
      error: null,
    });
  });

  it("leaves a run alone when one is already live", async () => {
    world.liveRun = { id: RUN };
    findFirstSpy.mockResolvedValue(stored("cancelled"));
    await person().update({ id: SESSION, status: "active" });
    expect(rowWrites.find((w) => w.table === playbookRuns)).toBeUndefined();
  });

  it("posts one system line in the room naming who reopened it", async () => {
    findFirstSpy.mockResolvedValue(stored("cancelled"));
    await person().update({ id: SESSION, status: "active" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      channelId: ROOM,
      role: "system",
      triggerAI: false,
    });
    expect(posted[0]!.content).toMatch(/^Ada reopened this session/);
  });

  it("answers a conflict when the session left cancelled meanwhile", async () => {
    findFirstSpy.mockResolvedValue(stored("cancelled"));
    world.locked = { status: "active", expectedOutputs: [] };
    await expect(
      person().update({ id: SESSION, status: "active" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(statusMoves).toEqual([]);
  });
});

describe("an AGENT never reopens a cancelled session — refused, not proposed", () => {
  it("tRPC with an agent key: refused with the person-only reason, nothing written", async () => {
    findFirstSpy.mockResolvedValue(stored("cancelled"));
    await expect(
      agent().update({ id: SESSION, status: "active" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/only a person can reopen/),
    });
    expect(statusMoves).toEqual([]);
    expect(rowWrites).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("MCP/Hub service door: denied with the reason before any membrane", async () => {
    findFirstSpy.mockResolvedValue(stored("cancelled"));
    const res = await updateFocusSession({
      sessionId: SESSION,
      userId: "user-1",
      agentUserId: "agent-1",
      status: "active",
    });
    expect(res).toMatchObject({
      status: "denied",
      reason: expect.stringMatching(/only a person can reopen/),
    });
    expect(statusMoves).toEqual([]);
    expect(rowWrites).toEqual([]);
  });
});

describe("a CLOSED or FAILED session stays closed, even for a person", () => {
  for (const from of ["closed", "failed"]) {
    it(`refuses the person's ${from} → active, and writes nothing`, async () => {
      findFirstSpy.mockResolvedValue(stored(from));
      await expect(
        person().update({ id: SESSION, status: "active" })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/a closed run stays closed/),
      });
      expect(statusMoves).toEqual([]);
      expect(rowWrites).toEqual([]);
    });
  }
});
