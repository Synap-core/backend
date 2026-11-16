/**
 * A run whose step is HANDED to an agent on a computer is not failed by the
 * 2-hour window while that agent shows as LIVE (a hub key of it used within
 * 15 minutes, the hand-off roster's `live`; finding 58b10b9a). Silent for
 * longer, the window applies; a run with no agent step fails at 2 hours.
 *
 * The REAL `handlePlaybookRunReaper` against PGlite.
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
  apiKeys,
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

/**
 * An IS run started 3 hours ago, its session quiet as long. `agent`: its step
 * is handed to an agent on a computer whose key was last used `agent.keyAgeMin`
 * minutes ago (null = no agent step).
 */
async function isRun(
  agent: { keyAgeMin: number } | null
): Promise<{ run: string; sess: string }> {
  const sess = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at, channel_id)
     values ($1, 'u1', 'g', 'paused', '{}'::jsonb, '[]'::jsonb, now() - interval '3 hours', now() - interval '3 hours', $2)`,
    [sess, randomUUID()]
  );
  const agentId = `agent-${randomUUID()}`;
  await q(
    `insert into session_stage_runs (id, session_id, stage_key, attempt, runner_agent_user_id, computer_user_id, runner_via, status, started_at)
     values ($1, $2, 'enrich', 1, $3, $4, 'stage', 'running', now() - interval '3 hours')`,
    [
      randomUUID(),
      sess,
      agent ? agentId : null,
      agent ? "computer-1" : null,
    ]
  );
  if (agent) {
    await q(
      `insert into api_keys (id, user_id, key_type, last_used_at)
       values ($1, $2, 'hub_inbound', now() - ($3::int * interval '1 minute'))`,
      [randomUUID(), agentId, agent.keyAgeMin]
    );
  }
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
    apiKeys,
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
    "delete from focus_sessions; delete from playbook_runs; delete from session_stage_runs; delete from lifecycle_transition_outbox; delete from api_keys;"
  );
});

describe("a step handed to a computer agent", () => {
  it("is exempt from the 2-hour window while the agent is live, and fails once it is silent; a run with no agent step fails", async () => {
    const live = await isRun({ keyAgeMin: 5 });
    const silent = await isRun({ keyAgeMin: 45 });
    const noAgent = await isRun(null);
    await handlePlaybookRunReaper();
    expect(await statusOf(live.run)).toBe("running");
    expect(await statusOf(silent.run)).toBe("failed");
    expect(await statusOf(noAgent.run)).toBe("failed");
    expect(closed.sort()).toEqual([silent.sess, noAgent.sess].sort());
  });
});
