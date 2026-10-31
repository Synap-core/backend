/**
 * `advanceSessionStage` — the ONE door every stage advance goes through.
 *
 * What is pinned here:
 *   • an advance into a GATED stage pauses the session and files EXACTLY ONE
 *     proposal — the defect was three doors doing neither,
 *   • an advance into an UNGATED stage emits `stage_changed` and files nothing,
 *   • a NO-OP advance (`toStage` equals the stage already held) emits nothing,
 *     files nothing and touches no row — the resolver is never consulted,
 *   • `stageWrite` decides who writes the column, and getting it wrong is the
 *     difference between one write and two: "caller" must NOT issue an UPDATE,
 *     "door" MUST.
 *
 * The api suite has no live Postgres, so `db` is partially stubbed (real tables
 * and operators kept) and the door runs for real against it. The UPDATE payloads
 * and the proposal input — the things under test — are real.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/** Every `db.update(...).set(...)` payload, in order. */
const updates: Array<Record<string, unknown>> = [];
/** The running `playbook_runs` row, if any. */
let runRow: Record<string, unknown> | undefined;
/** The live `playbooks` row's stages. */
let playbookStages: unknown[] = [];
/** Every `createEventBackedProposal` call. */
const proposalCalls: Array<Record<string, unknown>> = [];
/** Every `emitSideEffects` call. */
const emits: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  // PARTIAL, never total: a total replacement kills the whole FILE the moment
  // the module under test imports a new export, and reads as "0 tests".
  const actual = await importOriginal<typeof import("@synap/database")>();
  let selectingRuns = true;
  return {
    ...actual,
    // The stage ledger's one append (0382): a marker carrying the move, so a
    // test reads WHAT was recorded instead of a SQL fragment.
    appendSessionStageHistory: (move: Record<string, unknown>) => ({
      __ledger: move,
    }),
    // The one session status write: records the status it writes beside the
    // caller's other columns.
    setSessionStatus: async (
      _db: unknown,
      input: { to: string; set?: Record<string, unknown> }
    ) => {
      updates.push({ ...input.set, status: input.to });
      return { rows: [{ id: SESSION_ID }], transitions: [] };
    },
    db: {
      select: (cols: Record<string, unknown>) => {
        selectingRuns = "definitionSnapshot" in cols;
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => (runRow ? [runRow] : []),
              }),
              limit: async () =>
                selectingRuns
                  ? runRow
                    ? [runRow]
                    : []
                  : [{ stages: playbookStages }],
            }),
          }),
        };
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: () => {
              const result = { returning: async () => [{ id: SESSION_ID }] };
              // The door's own single-column UPDATE does not call `.returning()`;
              // the gate's pause does. Both must work off this one chain.
              return Object.assign(
                Promise.resolve([{ id: SESSION_ID }]),
                result
              );
            },
          };
        },
      }),
    },
  };
});

vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: Record<string, unknown>) => {
    proposalCalls.push(input);
    return {
      proposal: { id: "prop-1", status: "pending" },
      requestedEvent: null,
    };
  },
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: async (input: Record<string, unknown>) => {
    emits.push(input);
  },
}));

const { advanceSessionStage } = await import("../advance-stage.js");

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const PLAYBOOK_ID = "22222222-3333-4444-8555-666666666666";
const RUN_ID = "33333333-4444-4555-8666-777777777777";
const USER_ID = "44444444-5555-4666-8777-888888888888";

/** The ledger marker the mocked append returns for a human move. */
const ledger = (fromStage: string | null, toStage: string) => ({
  __ledger: {
    fromStage,
    toStage,
    userId: USER_ID,
    agentUserId: null,
    via: "advance",
  },
});

const session = (currentStage: string | null) => ({
  id: SESSION_ID,
  currentStage,
  workspaceId: "ws-1",
  projectId: null,
  channelId: null,
  playbookId: PLAYBOOK_ID,
  subjectEntityId: null,
});

const STAGES = [
  { key: "draft", name: "Draft" },
  {
    key: "review",
    name: "Review",
    goal: "Sign it off",
    gate: { kind: "human" },
  },
  { key: "ship", name: "Ship" },
];

beforeEach(() => {
  updates.length = 0;
  proposalCalls.length = 0;
  emits.length = 0;
  playbookStages = STAGES;
  runRow = {
    id: RUN_ID,
    definitionSnapshot: { stages: STAGES },
  };
});

describe("advanceSessionStage — the gated path", () => {
  it("pauses the session and files EXACTLY ONE proposal", async () => {
    const result = await advanceSessionStage({
      session: session("draft"),
      toStage: "review",
      userId: USER_ID,
      stageWrite: "caller",
    });

    expect(result).toMatchObject({ changed: true, gated: true, paused: true });
    expect(result.proposalId).toBe("prop-1");

    // Exactly one — not one per door, not one per field in the patch.
    expect(proposalCalls).toHaveLength(1);
    expect(proposalCalls[0]).toMatchObject({
      targetType: "focus_session",
      targetId: SESSION_ID,
      action: "stage_gate",
      sessionId: SESSION_ID,
    });
    expect(proposalCalls[0].summary).toContain("Review");

    // On the "caller" path the door writes the ledger entry, then the pause;
    // never the column (the caller's own UPDATE carried it).
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ stageHistory: ledger("draft", "review") });
    expect(updates[1]).toMatchObject({ status: "paused" });
    expect(updates[1]).not.toHaveProperty("currentStage");
  });

  it("still emits stage_changed — the stage STANDS, the run is merely paused", async () => {
    await advanceSessionStage({
      session: session("draft"),
      toStage: "review",
      userId: USER_ID,
      stageWrite: "caller",
    });
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({
      subjectType: "focus_session",
      action: "stage_changed",
    });
    expect(emits[0].data).toMatchObject({
      fromStage: "draft",
      toStage: "review",
    });
  });

  it("carries the agent identity onto the gate proposal when an agent advanced", async () => {
    await advanceSessionStage({
      session: session("draft"),
      toStage: "review",
      userId: USER_ID,
      agentUserId: "agent-9",
      stageWrite: "caller",
    });
    expect(proposalCalls[0]).toMatchObject({
      agentUserId: "agent-9",
      createdBy: "agent-9",
    });
  });
});

describe("advanceSessionStage — the ungated path is unchanged", () => {
  it("emits stage_changed and files NOTHING", async () => {
    const result = await advanceSessionStage({
      session: session("review"),
      toStage: "ship",
      userId: USER_ID,
      stageWrite: "caller",
    });
    expect(result).toMatchObject({
      changed: true,
      gated: false,
      paused: false,
    });
    expect(proposalCalls).toEqual([]);
    expect(updates).toEqual([{ stageHistory: ledger("review", "ship") }]);
    expect(emits).toHaveLength(1);
  });

  it("a NO-OP advance touches nothing at all", async () => {
    const result = await advanceSessionStage({
      session: session("review"),
      toStage: "review",
      userId: USER_ID,
      stageWrite: "caller",
    });
    expect(result).toEqual({ changed: false, gated: false, paused: false });
    expect(emits).toEqual([]);
    expect(proposalCalls).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe("advanceSessionStage — stageWrite decides who writes the column", () => {
  it('"door" issues ONE UPDATE: the column and its ledger entry together', async () => {
    await advanceSessionStage({
      session: session("review"),
      toStage: "ship",
      userId: USER_ID,
      stageWrite: "door",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      currentStage: "ship",
      stageHistory: ledger("review", "ship"),
    });
  });

  it('"caller" appends the ledger entry only — the caller\'s own UPDATE carried the column', async () => {
    await advanceSessionStage({
      session: session("review"),
      toStage: "ship",
      userId: USER_ID,
      stageWrite: "caller",
    });
    expect(updates).toEqual([{ stageHistory: ledger("review", "ship") }]);
  });

  it("an agent's advance names the agent and the human on its entry", async () => {
    await advanceSessionStage({
      session: session(null),
      toStage: "draft",
      userId: USER_ID,
      agentUserId: "agent-9",
      stageWrite: "door",
    });
    expect(updates[0]).toMatchObject({
      stageHistory: {
        __ledger: {
          fromStage: null,
          toStage: "draft",
          userId: USER_ID,
          agentUserId: "agent-9",
        },
      },
    });
  });

  it('"door" + a gated stage writes the stage AND the pause, in that order', async () => {
    await advanceSessionStage({
      session: session("draft"),
      toStage: "review",
      userId: USER_ID,
      stageWrite: "door",
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ currentStage: "review" });
    expect(updates[1]).toMatchObject({ status: "paused" });
  });
});

describe("advanceSessionStage — the RUN's frozen definition wins", () => {
  it("a gate added to the LIVE playbook after the run started does not fire", async () => {
    // Snapshot: ship is ungated. Live row: ship gained a gate mid-run.
    runRow = {
      id: RUN_ID,
      definitionSnapshot: { stages: STAGES },
    };
    playbookStages = [
      ...STAGES.slice(0, 2),
      { key: "ship", name: "Ship", gate: { kind: "human" } },
    ];
    const result = await advanceSessionStage({
      session: session("review"),
      toStage: "ship",
      userId: USER_ID,
      stageWrite: "caller",
    });
    expect(result.gated).toBe(false);
    expect(proposalCalls).toEqual([]);
  });
});
