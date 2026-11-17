/**
 * RUN STATUS WRITERS COMPARE-AND-SET (plan 7d71ddcc wave 0, task 3). Two
 * writers wrote a run's status `WHERE id` only, so a write that arrived after
 * the run had ended overwrote its verdict:
 *
 *   - the `playbook_run/update` approval replay (`executors/playbook.ts`): an
 *     update filed while the run was live and approved after it was cancelled
 *     or finished re-stamped it;
 *   - `recordExecutorResult` (`run-playbook.ts`): an executor's result landing
 *     after the run ended (a cancel during a long executor call, an IS turn
 *     that completed it first) rewrote its status.
 *
 * Now both write only onto a LIVE run (`liveRunStatusWhere`), settle the
 * parent only when they wrote, and say when they did not (the approval's
 * receipt `applied: "none"`, the executor result's returned row as it
 * stands). The three session-side writers (complete, unfollow, reopen) read
 * the run in its expected status first; their compare-and-set closes the
 * window between that read and the write, which no test interleaves here.
 *
 * Real on PGlite: the two writers, `transitionProposal`. Stubbed: the
 * parent-automation settle (CAPTURED), the link door, event helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  settled: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      playbookRuns: actual.playbookRuns as never,
      proposals: actual.proposals as never,
      entities: actual.entities as never,
    },
  });
  const mocked = { ...actual, getDb: async () => db };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settleParentAutomationRunFromChild: async (p: Record<string, unknown>) => {
    h.settled.push(p);
  },
}));
vi.mock("../../links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLinks: async () => [],
  getLinksFor: async () => [],
  resolveGrantedCapabilities: async () => [],
}));
vi.mock("../../playbooks/executors/registry.js", () => ({
  resolveExecutor: () => ({ run: async () => ({ status: "running" }) }),
}));
vi.mock("../../focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => undefined,
}));
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));

import type { PgTable } from "drizzle-orm/pg-core";
import {
  playbookRuns,
  proposals,
  entities,
  focusSessions,
  lifecycleTransitionOutbox,
} from "@synap/database";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { recordExecutorResult } from "../../playbooks/run-playbook.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerPlaybookExecutors } from "../../../routers/proposals/executors/playbook.js";

registerPlaybookExecutors();

const OWNER = "11111111-1111-4111-8111-111111111111";

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seedRun(status: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, input, created_by, definition_snapshot, started_at, completed_at)
     values ($1, $2, null, 'is-agent', $3, '{}'::jsonb, $4, '{}'::jsonb, now(), $5)`,
    [
      id,
      randomUUID(),
      status,
      OWNER,
      status === "running" ? null : "2026-11-16T10:00:00.000Z",
    ]
  );
  return id;
}

const runOf = async (id: string) =>
  (
    await q<{
      status: string;
      summary: string | null;
      completed_at: string | null;
    }>(
      `select status, summary, completed_at from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!;

/** Approve a `playbook_run/update` proposal through its executor. */
async function approveUpdate(runId: string, data: Record<string, unknown>) {
  const proposalId = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, created_at, updated_at)
     values ($1, 'pending', 'update', 'playbook_run', $2, $3::jsonb, $4, now(), now())`,
    [proposalId, runId, JSON.stringify({ data: { runId, ...data } }), OWNER]
  );
  const ex = proposalExecRegistry.resolve("playbook_run/update", "update");
  expect(ex).toBeDefined();
  const result = await ex!.execute({
    proposal: {
      id: proposalId,
      targetType: "playbook_run",
      targetId: runId,
      proposalType: "update",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      sourceMessageId: null,
      data: { data: { runId, ...data } },
    },
    payload: null,
    userId: OWNER,
    input: { proposalId },
    ctx: {} as never,
    deps: {
      reportProposalOutcome: vi.fn(),
      emitProposalReviewed: vi.fn(),
    } as never,
  });
  const [p] = (
    await q<{ status: string }>(`select status from proposals where id = $1`, [
      proposalId,
    ])
  ).rows;
  return { result, proposalStatus: p!.status };
}

describe("run status writers write only onto a LIVE run", () => {
  beforeAll(async () => {
    for (const t of [
      playbookRuns,
      proposals,
      entities,
      lifecycleTransitionOutbox,
      focusSessions,
    ]) {
      await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
    }
  }, 120_000);

  beforeEach(() => {
    h.settled.length = 0;
  });

  it("playbook_run/update approved after the run was CANCELLED: the run keeps its verdict, the receipt says nothing was written, the proposal is answered", async () => {
    const runId = await seedRun("cancelled");
    const { result, proposalStatus } = await approveUpdate(runId, {
      status: "completed",
      summary: "Done.",
    });
    const run = await runOf(runId);
    expect(run.status).toBe("cancelled");
    expect(run.summary).toBeNull();
    expect(result).toMatchObject({
      success: true,
      effect: { applied: "none" },
    });
    expect(h.settled).toEqual([]);
    expect(proposalStatus).toBe("approved");
  });

  it("playbook_run/update on a LIVE run applies, settles the parent, and says so", async () => {
    const runId = await seedRun("waiting_on_you");
    const { result } = await approveUpdate(runId, {
      status: "completed",
      summary: "Done.",
    });
    const run = await runOf(runId);
    expect(run).toMatchObject({ status: "completed", summary: "Done." });
    expect(run.completed_at).not.toBeNull();
    expect(result).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 1, ids: [runId] },
    });
    expect(h.settled).toEqual([{ playbookRunId: runId }]);
  });

  it("recordExecutorResult after the run ended: its verdict stands, nothing is settled, and the run is returned as it stands", async () => {
    const runId = await seedRun("completed");
    const back = await recordExecutorResult(runId, {
      status: "failed",
      error: "late executor error",
    });
    expect(back).toMatchObject({ id: runId, status: "completed" });
    expect((await runOf(runId)).status).toBe("completed");
    expect(h.settled).toEqual([]);
  });

  it("recordExecutorResult on a LIVE run writes its result and settles the parent", async () => {
    const runId = await seedRun("running");
    const back = await recordExecutorResult(runId, {
      status: "failed",
      error: "Executor threw",
    });
    expect(back).toMatchObject({ id: runId, status: "failed" });
    expect(h.settled).toEqual([{ playbookRunId: runId }]);
  });
});
