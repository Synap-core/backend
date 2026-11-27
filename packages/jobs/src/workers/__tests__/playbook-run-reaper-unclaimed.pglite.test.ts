/**
 * A RUN NOBODY CLAIMED IS BLOCKED, NEVER RUNNING FOREVER AND NEVER FAILED.
 * A run is born `queued` with its holder; past its holder's claim window
 * (Synap AI: the work clock's `live` rung, anyone else: `quiet`) it moves to
 * `blocked` with the reason and who was passed over. A hand-off waiting for
 * the person's approval stops the clock, and so does a Synap AI turn still
 * waiting in pg-boss for a worker.
 *
 * The REAL `handlePlaybookRunReaper` against PGlite; the close door is
 * CAPTURED (its own suites cover it).
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
  channels,
  focusSessions,
  playbookRuns,
  messages,
  proposals,
  automationRuns,
  lifecycleTransitionOutbox,
  sessionStageRuns,
  apiKeys,
  users,
} from "@synap/database/schema";
import { passedOverLine } from "@synap-core/types/agents";
import { workClockIn } from "@synap-core/types/work-clock";
import {
  claimWindowMinutes,
  handlePlaybookRunReaper,
} from "../playbook-run-reaper.js";
import { A2AI_TRIGGER_QUEUE } from "../a2ai-response-trigger.js";
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

const AGENT = "agent-cloud";

/** A run handed `minutes` ago to `kind`, still queued. */
async function queued(opts: {
  kind: "synap_ai" | "agent";
  minutes: number;
  runOn?: unknown;
  handOffPending?: boolean;
  turnQueued?: boolean;
}): Promise<{ run: string; sess: string }> {
  const sess = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at, channel_id)
     values ($1, 'u1', 'g', 'active', '{}'::jsonb, '[]'::jsonb, now(), now() - interval '3 hours', $2)`,
    [sess, randomUUID()]
  );
  const assignedAt = new Date(Date.now() - opts.minutes * 60_000).toISOString();
  const id = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input, holder, run_on)
     values ($1, $2, $3, $4, 'queued', now() - interval '3 hours', 'u1', '{}'::jsonb, $5::jsonb, $6::jsonb)`,
    [
      id,
      randomUUID(),
      sess,
      opts.kind === "synap_ai" ? "is-agent" : "external-agent",
      JSON.stringify({
        kind: opts.kind,
        id: opts.kind === "agent" ? AGENT : null,
        assignedAt,
        claimedAt: null,
      }),
      opts.runOn ? JSON.stringify(opts.runOn) : null,
    ]
  );
  if (opts.handOffPending) {
    await q(
      `insert into proposals (id, session_id, status, proposal_type, target_type, target_id)
       values ($1, $2, 'pending', 'assign_agent', 'focus_session', $3)`,
      [randomUUID(), sess, sess]
    );
  }
  if (opts.turnQueued) {
    await q(
      `insert into pgboss.job (name, state, data) values ($1, 'created', $2::jsonb)`,
      [A2AI_TRIGGER_QUEUE, JSON.stringify({ focusSessionId: sess })]
    );
  }
  return { run: id, sess };
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from playbook_runs where id = $1`,
      [id]
    )
  ).rows[0]!.status;

/** The move into `blocked`, as its transition owes it. */
const blockedMove = async (id: string) =>
  (
    await q<{
      transition: {
        to: string;
        reason: string | null;
        hold: { on: string } | null;
      };
    }>(
      `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
      [id]
    )
  ).rows.find((r) => r.transition.to === "blocked")?.transition ?? null;

beforeAll(async () => {
  for (const t of [
    // The run reaper reads the session's room (a post is activity).
    channels,
    focusSessions,
    playbookRuns,
    messages,
    proposals,
    automationRuns,
    lifecycleTransitionOutbox,
    sessionStageRuns,
    apiKeys,
    users,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await q(`insert into users (id, name) values ($1, 'Cloud')`, [AGENT]);
  await h.client!.exec(
    "create schema pgboss; create table pgboss.job (name text, state text, data jsonb);"
  );
  registerSessionCloser(async ({ sessionId }) => ({
    session: { id: sessionId, status: "closed" },
    counts: { pending: 0, unfinishedOutputs: 0, expiredEphemerals: 0 },
    warnings: [],
  }));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from proposals; delete from lifecycle_transition_outbox; delete from pgboss.job;"
  );
});

describe("a run nobody claims is blocked with the reason", () => {
  it("windows are the work clock's rungs", () => {
    expect(claimWindowMinutes("synap_ai")).toBe(workClockIn("live", "minutes"));
    expect(claimWindowMinutes("agent")).toBe(workClockIn("quiet", "minutes"));
  });

  it("BLOCKS a Synap AI run unclaimed past its window, on the person, naming who was passed over", async () => {
    const { run } = await queued({
      kind: "synap_ai",
      minutes: claimWindowMinutes("synap_ai") + 1,
      runOn: {
        executor: "is-agent",
        agentUserId: null,
        via: "fallback",
        passedOver: { agentUserId: AGENT, name: "Cloud", why: "not_awake" },
      },
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(run)).toBe("blocked");
    const move = await blockedMove(run);
    expect(move?.hold?.on).toBe("person");
    expect(move?.reason).toContain(
      passedOverLine({ name: "Cloud", why: "not_awake" })
    );
  });

  it("BLOCKS an agent's run unclaimed past its window, naming the agent", async () => {
    const { run } = await queued({
      kind: "agent",
      minutes: claimWindowMinutes("agent") + 1,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(run)).toBe("blocked");
    expect((await blockedMove(run))?.reason).toContain("Cloud");
  });

  it("a Synap AI turn still waiting in pg-boss stops the clock; a finished job does not", async () => {
    const waiting = await queued({
      kind: "synap_ai",
      minutes: 60,
      turnQueued: true,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(waiting.run)).toBe("queued");
    await q(`update pgboss.job set state = 'completed'`);
    await handlePlaybookRunReaper();
    expect(await statusOf(waiting.run)).toBe("blocked");
  });

  it("leaves a run inside its holder's window queued", async () => {
    const synapAi = await queued({
      kind: "synap_ai",
      minutes: claimWindowMinutes("synap_ai") - 2,
    });
    const agent = await queued({
      kind: "agent",
      minutes: claimWindowMinutes("agent") - 10,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(synapAi.run)).toBe("queued");
    expect(await statusOf(agent.run)).toBe("queued");
  });

  it("a hand-off waiting for the person's approval stops the clock", async () => {
    const { run } = await queued({
      kind: "agent",
      minutes: 180,
      handOffPending: true,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(run)).toBe("queued");
  });
});

/**
 * A PLANNED step's run (founder P1/P4): its session is `forming`, so the run
 * has not started — it is not unclaimed, not quiet, not orphaned. Every sweep
 * leaves it until the pod wakes the step. Its twin under a started session,
 * one fact away (the status), is reaped as before.
 */
describe("a planned step's run is never reaped", () => {
  async function stepRun(
    sessionStatus: string,
    runStatus: "queued" | "running"
  ): Promise<string> {
    const sess = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at, channel_id)
       values ($1, 'u1', 'g', $2, '{}'::jsonb, '[]'::jsonb, now() - interval '40 days', now() - interval '30 days', $3)`,
      [sess, sessionStatus, randomUUID()]
    );
    const id = randomUUID();
    await q(
      `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input, holder)
       values ($1, $2, $3, 'is-agent', $4, now() - interval '30 days', 'u1', '{}'::jsonb, $5::jsonb)`,
      [
        id,
        randomUUID(),
        sess,
        runStatus,
        JSON.stringify({
          kind: "synap_ai",
          id: null,
          assignedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
          claimedAt: null,
        }),
      ]
    );
    return id;
  }

  it("leaves a planned step's queued and running runs as they are; their started twins are reaped", async () => {
    const plannedQueued = await stepRun("forming", "queued");
    const plannedRunning = await stepRun("forming", "running");
    const startedQueued = await stepRun("active", "queued");
    const startedRunning = await stepRun("active", "running");

    await handlePlaybookRunReaper();

    // Rules out: "a run is judged by its own clock alone".
    expect(await statusOf(plannedQueued)).toBe("queued");
    expect(await statusOf(plannedRunning)).toBe("running");
    // Non-vacuity: the same runs under a started session are reaped.
    expect(await statusOf(startedQueued)).toBe("blocked");
    expect(await statusOf(startedRunning)).toBe("failed");
  });
});
