/**
 * `focusSessions.update` honours a playbook stage's HUMAN GATE.
 *
 * Until 2026-09-12 it did not. A stage declaring `gate: { kind: "human" }` was
 * enforced only by the MCP service door; advancing the same run from the browser
 * through this tRPC procedure wrote `current_stage`, emitted `stage_changed` and
 * returned a happily `active` session — walking straight past the approval the
 * playbook author declared. This drives the REAL procedure and reads the actual
 * `set()` payloads and the actual proposal input.
 *
 * DB-FREE: `@synap/database` is partially mocked (real tables and operators kept,
 * connection replaced).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";
const PLAYBOOK = "22222222-3333-4444-8555-666666666666";
const RUN = "33333333-4444-4555-8666-777777777777";

const findFirstSpy = vi.fn();
/** Every top-level `update().set()` payload, in order. */
const sets: Record<string, unknown>[] = [];
/** Every `createEventBackedProposal` call. */
const proposalCalls: Record<string, unknown>[] = [];
/** The running playbook_runs row's frozen definition. */
let snapshotStages: unknown[] = [];

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
      // Only the stage-gate resolver selects: the running run, then (never
      // reached here) the live playbook row.
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => [
                { id: RUN, definitionSnapshot: { stages: snapshotStages } },
              ],
            }),
            limit: async () => [{ stages: snapshotStages }],
          }),
        }),
      }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          sets.push(patch);
          const rows = [{ id: SESSION, ...patch }];
          return {
            where: () =>
              Object.assign(Promise.resolve(rows), {
                returning: async () => rows,
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

vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));

vi.mock("../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: Record<string, unknown>) => {
    proposalCalls.push(input);
    return {
      proposal: { id: "prop-1", status: "pending" },
      requestedEvent: null,
    };
  },
}));

const { focusSessionsRouter } = await import("./focus-sessions.js");

const ctx = { userId: "user-1", authenticated: true } as never;
const caller = () => focusSessionsRouter.createCaller(ctx);

const GATED = [
  { key: "draft", name: "Draft" },
  { key: "review", name: "Review", gate: { kind: "human" } },
];
const UNGATED = [
  { key: "draft", name: "Draft" },
  { key: "review", name: "Review" },
];

beforeEach(() => {
  vi.clearAllMocks();
  sets.length = 0;
  proposalCalls.length = 0;
  snapshotStages = GATED;
  findFirstSpy.mockResolvedValue({
    id: SESSION,
    userId: "user-1",
    workspaceId: WS,
    projectId: null,
    channelId: null,
    playbookId: PLAYBOOK,
    subjectEntityId: null,
    goal: "Ship the thing",
    status: "active",
    currentStage: "draft",
    expectedOutputs: [],
  });
});

describe("focusSessions.update — advancing into a GATED stage", () => {
  it("pauses the session and files EXACTLY ONE gate proposal", async () => {
    await caller().update({ id: SESSION, currentStage: "review" });

    expect(proposalCalls).toHaveLength(1);
    expect(proposalCalls[0]).toMatchObject({
      targetType: "focus_session",
      targetId: SESSION,
      action: "stage_gate",
    });

    // Two writes: the door's own patch (which carried the stage), then the pause.
    expect(sets).toHaveLength(2);
    expect(sets[0]).toMatchObject({ currentStage: "review" });
    expect(sets[1]).toMatchObject({ status: "paused" });
  });

  it("returns the session as PAUSED — not the `active` the caller asked for", async () => {
    const out = (await caller().update({
      id: SESSION,
      currentStage: "review",
    })) as { status: string };
    // A caller told "active" past an open gate steps straight through it.
    expect(out.status).toBe("paused");
  });
});

describe("focusSessions.update — the ungated path is unchanged", () => {
  it("writes the stage once, files nothing, pauses nothing", async () => {
    snapshotStages = UNGATED;
    const out = (await caller().update({
      id: SESSION,
      currentStage: "review",
    })) as { status: string };

    expect(proposalCalls).toEqual([]);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ currentStage: "review" });
    expect(out.status).not.toBe("paused");
  });

  it("a patch with NO stage never consults the gate resolver", async () => {
    await caller().update({ id: SESSION, progress: 40 });
    expect(proposalCalls).toEqual([]);
    expect(sets).toHaveLength(1);
    expect(sets[0]).not.toHaveProperty("currentStage");
  });
});
