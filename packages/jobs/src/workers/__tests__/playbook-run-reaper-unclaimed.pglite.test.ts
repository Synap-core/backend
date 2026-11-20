/**
 * A RUN NOBODY CLAIMED IS BLOCKED, NEVER RUNNING FOREVER AND NEVER FAILED
 * (founder, 20 Nov 2026). A run is born `queued` with its holder; past its
 * holder's claim window (Synap AI: the work clock's `live` rung, anyone else:
 * `quiet`) it moves to `blocked` with the reason and who was passed over. A
 * hand-off waiting for the person's approval stops the clock (ticket
 * 3de3e0fb: the reaper killed a run whose hand-off was still pending).
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

const AGENT = "agent-cloud";

/** A run handed `minutes` ago to `kind`, still queued. */
async function queued(opts: {
  kind: "synap_ai" | "agent";
  minutes: number;
  runOn?: unknown;
  handOffPending?: boolean;
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
       values ($1, $2, 'pending', 'assign_agent', 'focus_session', $2)`,
      [randomUUID(), sess]
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

/** The reason the move into `blocked` carried, as its transition owes it. */
const blockedReason = async (id: string) =>
  (
    await q<{ transition: { to: string; reason: string | null } }>(
      `select transition from lifecycle_transition_outbox where transition->>'subjectId' = $1`,
      [id]
    )
  ).rows.find((r) => r.transition.to === "blocked")?.transition.reason ?? null;

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
    users,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await q(`insert into users (id, name) values ($1, 'Cloud')`, [AGENT]);
  registerSessionCloser(async ({ sessionId }) => ({
    session: { id: sessionId, status: "closed" },
    counts: { pending: 0, unfinishedOutputs: 0, expiredEphemerals: 0 },
    warnings: [],
  }));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from proposals; delete from lifecycle_transition_outbox;"
  );
});

describe("a run nobody claims is blocked with the reason", () => {
  it("BLOCKS a Synap AI run unclaimed past 5 minutes, naming who was passed over", async () => {
    const { run } = await queued({
      kind: "synap_ai",
      minutes: 6,
      runOn: {
        executor: "is-agent",
        agentUserId: null,
        via: "fallback",
        passedOver: { agentUserId: AGENT, name: "Cloud", why: "not_awake" },
      },
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(run)).toBe("blocked");
    const reason = await blockedReason(run);
    expect(reason).toContain("Synap AI did not pick it up within 5 minutes");
    expect(reason).toContain("Passed over: Cloud (not awake)");
  });

  it("BLOCKS an agent's run unclaimed past 30 minutes, by the agent's name", async () => {
    const { run } = await queued({ kind: "agent", minutes: 31 });
    await handlePlaybookRunReaper();
    expect(await statusOf(run)).toBe("blocked");
    expect(await blockedReason(run)).toContain(
      "Cloud did not pick it up within 30 minutes"
    );
  });

  it("leaves a run inside its holder's window queued", async () => {
    const synapAi = await queued({ kind: "synap_ai", minutes: 2 });
    const agent = await queued({ kind: "agent", minutes: 10 });
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
