/**
 * Approving a playbook stage gate RESUMES the session — and does nothing else.
 *
 * Three properties:
 *
 * 1. THE RESUME LANDS. A gate that flips the proposal green without writing
 *    `status = "active"` is a gate the waiting agent never sees clear — the
 *    `focus_session/*` shape of the severed-approval-door class (an executor
 *    returning `{ success: true }` over no write at all).
 *
 * 2. IT RESUMES ONLY FROM `paused`. A session the owner has since closed must
 *    not be reanimated by an approval that was about a stage boundary. The guard
 *    is in the WHERE clause, and the effect receipt reports what Postgres
 *    returned, never that the code reached its last line.
 *
 * 3. IT NEVER RUNS THE STAGE. The stage carries `grants` and `suggestedTasks` —
 *    playbook-authored content. If approval executed them, a reviewer tapping
 *    Approve on a phone would be an execution trigger. Pinned by SOURCE SCAN,
 *    not by behaviour: a behavioural test proves only that this path did not
 *    spawn anything, while the scan proves no process-spawning import exists in
 *    the module at all — the property that must hold for every future edit.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/** Every `db.update(...).set(...)` payload, tagged by table. */
const updates: Array<{ table: string; values: Record<string, unknown> }> = [];
/** What the session lookup returns; null = the session is gone. */
let sessionRow: Record<string, unknown> | null = null;
/** Rows the focus-session UPDATE's `.returning()` reports. */
let updateReturns: Array<Record<string, unknown>> = [];

vi.mock("@synap/database", async (importOriginal) => {
  // PARTIAL mock on purpose — see the sibling dev-approval suite.
  const actual = await importOriginal<typeof import("@synap/database")>();
  const tableName = (t: unknown): string =>
    t === actual.focusSessions ? "focus_sessions" : "proposals";
  return {
    ...actual,
    db: {
      query: { focusSessions: { findFirst: async () => sessionRow } },
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            const entry = { table: tableName(table), values };
            updates.push(entry);
            return {
              returning: async () =>
                entry.table === "focus_sessions" ? updateReturns : [],
              then: (resolve: (v: unknown) => unknown) => resolve(undefined),
            };
          },
        }),
      }),
    },
  };
});

const realtimeEvents: Array<Record<string, unknown>> = [];
vi.mock("../../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: (e: Record<string, unknown>) => {
    realtimeEvents.push(e);
  },
}));

import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerPlaybookStageGateExecutors } from "../playbook-stage-gate.js";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const KEY = "focus_session/playbook.stage_gate";

function args(
  overrides: Partial<{ targetId: string }> = {}
): ProposalExecutorArgs {
  return {
    proposal: {
      id: "p-1",
      targetType: "focus_session",
      targetId: overrides.targetId ?? SESSION_ID,
      proposalType: "playbook.stage_gate",
      workspaceId: "ws-1",
      sessionId: SESSION_ID,
      projectId: null,
      agentUserId: "agent-1",
      sourceMessageId: null,
      data: {
        sessionId: SESSION_ID,
        stageKey: "review",
        stageName: "Review",
        changeType: "stage_gate",
      },
    },
    payload: null,
    userId: "human-1",
    input: { proposalId: "p-1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {
      db: null,
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
      stampProjectMembership: async () => {},
      resolveMessagingAccountForPlatform: async () => null,
    } as unknown as ProposalExecutorArgs["deps"],
  };
}

function sessionUpdate(): Record<string, unknown> {
  const row = updates.find((u) => u.table === "focus_sessions");
  if (!row) throw new Error("no focus_sessions UPDATE was performed");
  return row.values;
}

beforeEach(() => {
  registerPlaybookStageGateExecutors();
  updates.length = 0;
  realtimeEvents.length = 0;
  updateReturns = [{ id: SESSION_ID, status: "active" }];
  sessionRow = {
    id: SESSION_ID,
    status: "paused",
    workspaceId: "ws-1",
    goal: "Ship the stage gate",
    progress: 40,
  };
});

describe("focus_session/playbook.stage_gate — approval resumes the run", () => {
  it("is registered under its own key, not the catch-all", () => {
    expect(proposalExecRegistry.resolveExact(KEY)).toBeDefined();
  });

  it("flips the paused session back to active and reports a verified effect", async () => {
    const executor = proposalExecRegistry.resolveExact(KEY)!;
    const result = (await executor.execute(args())) as unknown as Record<
      string,
      unknown
    >;

    expect(sessionUpdate().status).toBe("active");
    expect(result.success).toBe(true);
    const effect = result.effect as Record<string, unknown>;
    expect(effect.applied).toBe("verified");
    expect(effect.rows).toBe(1);
    expect(effect.subject).toBe("focus_session");

    // The proposal row is marked approved by this executor, not left pending.
    expect(updates.some((u) => u.table === "proposals")).toBe(true);
    expect(realtimeEvents).toHaveLength(1);
  });

  it("never touches currentStage — the stage already stands", async () => {
    const executor = proposalExecRegistry.resolveExact(KEY)!;
    await executor.execute(args());
    expect(sessionUpdate()).not.toHaveProperty("currentStage");
  });

  it("reports `none` when the session was not paused — no invented resume", async () => {
    updateReturns = [];
    sessionRow = { ...sessionRow, status: "closed" };
    const executor = proposalExecRegistry.resolveExact(KEY)!;
    const result = (await executor.execute(args())) as unknown as Record<
      string,
      unknown
    >;

    const effect = result.effect as Record<string, unknown>;
    expect(effect.applied).toBe("none");
    expect(String(effect.reason)).toContain("not paused");
    // No realtime "it is active now" event for a session that is not.
    expect(realtimeEvents).toHaveLength(0);
    // The gate is still answered — the proposal is still marked approved.
    expect(updates.some((u) => u.table === "proposals")).toBe(true);
  });

  it("throws rather than silently succeeding when the session is gone", async () => {
    sessionRow = null;
    const executor = proposalExecRegistry.resolveExact(KEY)!;
    await expect(executor.execute(args())).rejects.toThrow(/no longer exists/);
  });
});

describe("the executor never runs the stage", () => {
  it("imports nothing that can spawn a process or reach the network", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "playbook-stage-gate.ts"),
      "utf8"
    );
    for (const forbidden of [
      "child_process",
      "node:child_process",
      "execSync",
      "spawn",
      "capabilities.execute",
      "runPlaybook",
      "triggerAutomation",
    ]) {
      expect(
        source.includes(forbidden),
        `must not reference ${forbidden}`
      ).toBe(false);
    }
  });
});
