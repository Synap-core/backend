/**
 * Advancing INTO a gated stage pauses the session and files the gate.
 *
 * What is pinned here:
 *   • an UNGATED stage costs nothing and files nothing (the overwhelmingly
 *     common path — a regression here would file a proposal on every advance),
 *   • a gated stage pauses the session AND files exactly one proposal carrying
 *     the session, the run and the stage key,
 *   • the pause is guarded on `status = "active"`, and `paused` in the result
 *     reports what the UPDATE returned rather than that the code reached the
 *     end — a session already closed must not be reported as paused,
 *   • the RUN's frozen definition wins over the live playbook row. A playbook
 *     edited mid-run must not add or remove a gate under a run that never
 *     agreed to it.
 *
 * The api suite has no live Postgres, so `db` is stubbed and the service runs
 * for real against it — the UPDATE payload and the proposal input, the things
 * under test, are real.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/** Every `db.update(...).set(...)` payload. */
const updates: Array<Record<string, unknown>> = [];
/** Rows the focus-session UPDATE's `.returning()` reports (empty = not active). */
let updateReturns: Array<Record<string, unknown>> = [];
/** The running `playbook_runs` row, if any. */
let runRow: Record<string, unknown> | undefined;
/** The live `playbooks` row's stages. */
let playbookStages: unknown[] = [];
/** Every `createEventBackedProposal` call. */
const proposalCalls: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  // PARTIAL mock on purpose: a total replacement silently kills every other
  // export the module under test imports the moment a new one is added, with
  // typecheck still green.
  const actual = await importOriginal<typeof import("@synap/database")>();
  let selectingRuns = true;
  return {
    ...actual,
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
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              updates.push(values);
              return updateReturns;
            },
          }),
        }),
      }),
    },
  };
});

vi.mock("../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: Record<string, unknown>) => {
    proposalCalls.push(input);
    return {
      proposal: { id: "prop-1", status: "pending" },
      requestedEvent: null,
    };
  },
}));

import { applyStageGateOnAdvance, findStage } from "./stage-gate.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const PLAYBOOK_ID = "22222222-3333-4444-8555-666666666666";
const RUN_ID = "33333333-4444-4555-8666-777777777777";

const GATED = {
  key: "review",
  name: "Review",
  category: "started",
  goal: "Get a human to sign off",
  gate: { kind: "human" },
};
const UNGATED = { key: "build", name: "Build", category: "started" };

function advance(toStage: string) {
  return applyStageGateOnAdvance({
    sessionId: SESSION_ID,
    userId: "human-1",
    agentUserId: "agent-1",
    workspaceId: "ws-1",
    projectId: null,
    channelId: null,
    playbookId: PLAYBOOK_ID,
    toStage,
    fromStage: "build",
  });
}

beforeEach(() => {
  updates.length = 0;
  proposalCalls.length = 0;
  updateReturns = [{ id: SESSION_ID }];
  runRow = { id: RUN_ID, definitionSnapshot: { stages: [UNGATED, GATED] } };
  playbookStages = [UNGATED, GATED];
});

describe("findStage", () => {
  it("finds by key and tolerates a non-array bag", () => {
    expect(findStage([UNGATED, GATED], "review")).toEqual(GATED);
    expect(findStage([UNGATED], "review")).toBeUndefined();
    expect(findStage(null, "review")).toBeUndefined();
    expect(findStage("nonsense", "review")).toBeUndefined();
  });
});

describe("applyStageGateOnAdvance", () => {
  it("an ungated stage neither pauses nor files", async () => {
    expect(await advance("build")).toBeNull();
    expect(updates).toHaveLength(0);
    expect(proposalCalls).toHaveLength(0);
  });

  it("an unknown stage key neither pauses nor files", async () => {
    expect(await advance("does-not-exist")).toBeNull();
    expect(updates).toHaveLength(0);
    expect(proposalCalls).toHaveLength(0);
  });

  it("a gated stage pauses the session and files exactly one proposal", async () => {
    const result = await advance("review");

    expect(result).not.toBeNull();
    expect(result!.paused).toBe(true);
    expect(result!.proposalId).toBe("prop-1");
    expect(result!.proposalType).toBe("playbook.stage_gate");
    expect(result!.stageKey).toBe("review");

    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe("paused");

    expect(proposalCalls).toHaveLength(1);
    const call = proposalCalls[0];
    expect(call.targetType).toBe("focus_session");
    expect(call.targetId).toBe(SESSION_ID);
    expect(call.proposalType).toBe("playbook.stage_gate");
    // The provenance the reviewer and the session lens both read.
    expect(call.sessionId).toBe(SESSION_ID);
    expect(call.agentUserId).toBe("agent-1");
    const data = call.data as Record<string, unknown>;
    expect(data.stageKey).toBe("review");
    expect(data.stageName).toBe("Review");
    expect(data.stageGoal).toBe("Get a human to sign off");
    expect(data.playbookRunId).toBe(RUN_ID);
    expect(data.fromStage).toBe("build");
    expect(String(call.summary)).toContain("Review");
  });

  it("reports paused:false when the session was not active — no invented pause", async () => {
    updateReturns = [];
    const result = await advance("review");
    expect(result!.paused).toBe(false);
    // The gate is still filed: the human still owes an answer even though the
    // session was already out of `active`.
    expect(proposalCalls).toHaveLength(1);
  });

  it("the RUN's frozen definition wins over a mid-run playbook edit", async () => {
    // The live playbook has since REMOVED the gate; the run started with it.
    runRow = { id: RUN_ID, definitionSnapshot: { stages: [UNGATED, GATED] } };
    playbookStages = [UNGATED, { ...GATED, gate: undefined }];
    expect((await advance("review"))!.paused).toBe(true);

    // And the reverse: a gate ADDED after the run started does not apply, because
    // the snapshot has the last word for a stage the snapshot knows.
    updates.length = 0;
    proposalCalls.length = 0;
    runRow = {
      id: RUN_ID,
      definitionSnapshot: { stages: [UNGATED, { ...GATED, gate: undefined }] },
    };
    playbookStages = [UNGATED, GATED];
    expect(await advance("review")).toBeNull();
    expect(proposalCalls).toHaveLength(0);
  });

  it("falls back to the playbook row when there is no run", async () => {
    runRow = undefined;
    const result = await advance("review");
    expect(result!.paused).toBe(true);
    expect(
      (proposalCalls[0].data as Record<string, unknown>).playbookRunId
    ).toBeUndefined();
  });
});
