/**
 * An IS run past its 2-hour window whose step WAITS (on its `forEach`
 * children, a `uses` child or tools) is waiting, not dead: the IS window spares
 * it like the 24-hour one does (`RUN_STAGE_NOT_WAITING` in both). Otherwise a
 * parent waiting more than 2 hours on its children was failed, and the last
 * child's close then resumed a failed run.
 *
 * The REAL `handlePlaybookRunReaper` against PGlite; each waiting run has a
 * twin whose step is done, which the reaper fails.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  playbookRuns,
  messages,
  proposals,
  automationRuns,
  lifecycleTransitionOutbox,
  sessionStageRuns,
} from "@synap/database/schema";
import { handlePlaybookRunReaper } from "../playbook-run-reaper.js";
import { registerSessionCloser } from "../../utils/session-close.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const closed: string[] = [];

/** An IS run started 3 hours ago, its session quiet as long, its step `stepStatus`. */
async function isRun(
  stepStatus: string
): Promise<{ run: string; sess: string }> {
  const sess = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at, channel_id)
     values ($1, 'u1', 'g', 'paused', '{}'::jsonb, '[]'::jsonb, now() - interval '3 hours', now() - interval '3 hours', $2)`,
    [sess, randomUUID()]
  );
  await q(
    `insert into session_stage_runs (id, session_id, stage_key, attempt, runner_via, status, started_at)
     values ($1, $2, 'enrich', 1, 'stage', $3, now() - interval '3 hours')`,
    [randomUUID(), sess, stepStatus]
  );
  const run = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input)
     values ($1, $2, $3, 'is-agent', 'running', now() - interval '3 hours', 'u1', '{}'::jsonb)`,
    [run, randomUUID(), sess]
  );
  return { run, sess };
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!.status;

beforeAll(async () => {
  for (const t of [
    focusSessions,
    playbookRuns,
    messages,
    proposals,
    automationRuns,
    lifecycleTransitionOutbox,
    sessionStageRuns,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  registerSessionCloser(async ({ sessionId }) => {
    closed.push(sessionId);
    return {
      session: { id: sessionId, status: "closed" },
      counts: { pending: 0, unfinishedOutputs: 0, expiredEphemerals: 0 },
      warnings: [],
    };
  });
}, 120_000);

beforeEach(async () => {
  closed.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from session_stage_runs; delete from lifecycle_transition_outbox;"
  );
});

describe("the IS window spares a run whose step waits", () => {
  it("an IS run 3 hours old whose step waits on its children or on tools is not reaped; its done-step twin is", async () => {
    const onChildren = await isRun("waiting_child");
    const onTools = await isRun("waiting_tools");
    const doneStep = await isRun("done");
    await handlePlaybookRunReaper();
    expect(await statusOf(onChildren.run)).toBe("running");
    expect(await statusOf(onTools.run)).toBe("running");
    expect(await statusOf(doneStep.run)).toBe("failed");
    expect(closed).toEqual([doneStep.sess]);
  });
});
