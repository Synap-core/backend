/**
 * ONE CARD PER QUESTION at the tRPC `focusSessions.update` door (an agent
 * driving it): the list is WHOLESALE here (a slot it omits is deleted), so a
 * new card is a twin only of an open card the same list KEEPS. Drives the
 * real procedure; the write is read where it lands (`writeSessionPatch`).
 * Harness of `focus-sessions.reopen-cancelled.test.ts` (DB-free).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const ROOM = "44444444-4444-4444-8444-444444444444";
void RUN;

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
    // The run status door (pinned on PGlite by run-status.pglite.test.ts):
    // recorded as the run row's write.
    setRunStatus: async (
      _tx: unknown,
      input: { runId?: string; to: string; set?: Record<string, unknown> }
    ) => {
      const patch = { status: input.to, ...(input.set ?? {}) };
      rowWrites.push({ table: actual.playbookRuns, patch });
      return { rows: [{ id: input.runId, ...patch }], transitions: [] };
    },
    writeSessionPatch: async (
      _db: unknown,
      input: { set: Record<string, unknown> }
    ) => {
      rowWrites.push({ table: actual.focusSessions, patch: input.set });
      return [{ ...stored("active"), ...input.set }];
    },
    db: {
      // The proposal door's one statement (`WITH … UPDATE`).
      $with: () => ({ as: () => ({}) }),
      with() {
        return this;
      },
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
const { focusSessions } = await import("@synap/database");

const caller = (agentUserId?: string) =>
  focusSessionsRouter.createCaller({
    userId: "user-1",
    ...(agentUserId ? { agentUserId } : {}),
    authenticated: true,
  } as never);

const OPTIONS = [
  { label: "Nurturing", value: "nurturing" },
  { label: "Disqualified", value: "disqualified" },
];
const FIRST = {
  key: "validation-esteban-arias",
  kind: "decision",
  label: "Disposition Esteban Arias — Nurturing ou Disqualified",
  owner: "human",
  blockedReason: "decision",
  why: "Antoine doit choisir.",
  ask: { mode: "choose", options: OPTIONS },
};
const SECOND = {
  key: "disposition-esteban-arias",
  kind: "decision",
  label: "Disposition d'Esteban Arias (Prometheus)",
  owner: "human",
  blockedReason: "decision",
  why: "Pas un fit actuel.",
  ask: { mode: "choose", options: OPTIONS },
};

function stored(status: string) {
  return {
    id: SESSION,
    userId: "user-1",
    workspaceId: WS,
    goal: "Pipeline",
    status,
    channelId: ROOM,
    currentStage: null,
    expectedOutputs: [FIRST],
    criteria: [],
    agentIds: [],
    metadata: {},
  };
}

const writtenLabels = () => {
  const write = rowWrites
    .filter((w) => w.table === focusSessions)
    .find((w) => "expectedOutputs" in w.patch);
  return (write!.patch.expectedOutputs as Array<{ label: string }>).map(
    (o) => o.label
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  statusMoves.length = 0;
  rowWrites.length = 0;
  posted.length = 0;
  world.locked = { status: "active", expectedOutputs: [FIRST] };
  world.liveRun = null;
  world.latestRun = null;
  findFirstSpy.mockResolvedValue(stored("active"));
});

describe("tRPC focusSessions.update — one card per question", () => {
  it("an agent's list keeping the open card: its twin is left out", async () => {
    await caller("agent-1").update({
      id: SESSION,
      expectedOutputs: [FIRST, SECOND] as never,
    });
    expect(writtenLabels()).toEqual([FIRST.label]);
  });

  it("an agent's list DROPPING the open card: the new card is no twin of a card the same write deletes", async () => {
    await caller("agent-1").update({
      id: SESSION,
      expectedOutputs: [SECOND] as never,
    });
    expect(writtenLabels()).toEqual([SECOND.label]);
  });

  it("CONTROL: the person's own list is written as sent", async () => {
    await caller().update({
      id: SESSION,
      expectedOutputs: [FIRST, SECOND] as never,
    });
    expect(writtenLabels()).toEqual([FIRST.label, SECOND.label]);
  });
});
