/**
 * A step that WAITS — on a child run (`waiting_child`, a step that IS a
 * playbook) or on tools being installed (`waiting_tools`) — keeps its run and
 * session alive: the reapers read it as waiting, not idle (runner engine spec
 * 7111934d, risk 3; `stageRunWaitsWhere`, @synap/database).
 *
 * On PGlite, through the REAL handlers and their REAL WHERE clauses. Every
 * case pairs a waiting step with an otherwise-identical twin whose step is
 * done (or running), so a guard that skipped everything fails the other half.
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
vi.mock("../../utils/post-run-summary.js", () => ({
  postRunSummary: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  proposals,
  automationRuns,
  automationStepRuns,
  playbookRuns,
  messages,
  chatTurns,
  events,
  lifecycleTransitionOutbox,
  sessionStageRuns,
} from "@synap/database/schema";
import { handleFocusSessionReaper } from "../focus-session-reaper.js";
import { handlePlaybookRunReaper } from "../playbook-run-reaper.js";
import {
  registerSessionCloser,
  registerStoppedSessionStaler,
} from "../../utils/session-close.js";

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

async function session(opts: {
  idleHours: number;
  outputs?: unknown[];
  metadata?: Record<string, unknown>;
  status?: string;
  /** When it started (days ago) — the agent-evidence floor. Default: now. */
  startedDaysAgo?: number;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at, channel_id)
     values ($1, 'u1', 'g', $2, $3::jsonb, $4::jsonb, now() - ($7::int * interval '1 day'), now() - ($5::int * interval '1 hour'), $6)`,
    [
      id,
      opts.status ?? "active",
      JSON.stringify(opts.metadata ?? {}),
      JSON.stringify(opts.outputs ?? []),
      opts.idleHours,
      roomOf(id),
      opts.startedDaysAgo ?? 0,
    ]
  );
  return id;
}

/** Each session's room id, derived so a question can be posted into it. */
const rooms = new Map<string, string>();
function roomOf(sessionId: string): string {
  if (!rooms.has(sessionId)) rooms.set(sessionId, randomUUID());
  return rooms.get(sessionId)!;
}

const statusOf = async (table: string, id: string) =>
  (
    await q<{ status: string }>(`select status from ${table} where id = $1`, [
      id,
    ])
  ).rows[0]!.status;

async function step(sessionId: string, status: string): Promise<void> {
  await q(
    `insert into session_stage_runs (id, session_id, stage_key, attempt, runner_via, status, started_at)
     values ($1, $2, 'render', 1, 'stage', $3, now() - interval '30 hours')`,
    [randomUUID(), sessionId, status]
  );
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    automationRuns,
    automationStepRuns,
    playbookRuns,
    messages,
    chatTurns,
    events,
    lifecycleTransitionOutbox,
    sessionStageRuns,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  registerStoppedSessionStaler(async ({ sessionId }) => ({
    sessionId,
    retiredSlots: 0,
    closedQuestions: 0,
  }));
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

describe("focus-session reaper: a step that waits is not idle", () => {
  it("never stales a quiet session whose step waits on a child or on tools; stales the twins", async () => {
    const onChild = await session({ idleHours: 30 });
    await step(onChild, "waiting_child");
    const onTools = await session({ idleHours: 30 });
    await step(onTools, "waiting_tools");
    const doneStep = await session({ idleHours: 30 });
    await step(doneStep, "done");
    const runningStep = await session({ idleHours: 30 });
    await step(runningStep, "running");
    await handleFocusSessionReaper();
    expect(await statusOf("focus_sessions", onChild)).toBe("active");
    expect(await statusOf("focus_sessions", onTools)).toBe("active");
    expect(await statusOf("focus_sessions", doneStep)).toBe("stale");
    expect(await statusOf("focus_sessions", runningStep)).toBe("stale");
  });
});

describe("playbook-run reaper: a run whose step waits is not reaped", () => {
  async function staleRun(stepStatus: string | null) {
    const sess = await session({ idleHours: 30, status: "stale" });
    if (stepStatus) await step(sess, stepStatus);
    const run = randomUUID();
    await q(
      `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input)
       values ($1, $2, $3, 'is-agent', 'running', now() - interval '30 hours', 'u1', '{}'::jsonb)`,
      [run, randomUUID(), sess]
    );
    return { run, sess };
  }

  it("leaves a run waiting on a child or on tools running; the twins fail", async () => {
    const onChild = await staleRun("waiting_child");
    const onTools = await staleRun("waiting_tools");
    const doneStep = await staleRun("done");
    const noStep = await staleRun(null);
    await handlePlaybookRunReaper();
    expect(await statusOf("playbook_runs", onChild.run)).toBe("running");
    expect(await statusOf("playbook_runs", onTools.run)).toBe("running");
    expect(closed).not.toContain(onChild.sess);
    expect(await statusOf("playbook_runs", doneStep.run)).toBe("failed");
    expect(await statusOf("playbook_runs", noStep.run)).toBe("failed");
  });
});
