/**
 * AN IS RUN IS REAPED AFTER 2 HOURS, AN EXTERNAL AGENT'S AFTER 24 (finding
 * db27cac2: outage runs stayed active for a day). A run the pod handed to its own AI reports every turn's end, failed
 * included, so a run nobody moved for 2 hours is a dead worker. An external
 * agent works on its own clock and keeps the 24-hour window (D6).
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

/** A run `startedHours` ago on a session last touched `idleHours` ago. */
async function run(opts: {
  executor: "is-agent" | "external-agent";
  startedHours: number;
  idleHours: number;
  clientKey?: string;
  outputs?: unknown[];
}): Promise<{ run: string; sess: string }> {
  const sess = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at, channel_id)
     values ($1, 'u1', 'g', 'active', $2::jsonb, $3::jsonb, now() - ($4::int * interval '1 hour'), now() - ($5::int * interval '1 hour'), $6)`,
    [
      sess,
      JSON.stringify(opts.clientKey ? { clientKey: opts.clientKey } : {}),
      JSON.stringify(opts.outputs ?? []),
      opts.startedHours,
      opts.idleHours,
      randomUUID(),
    ]
  );
  const id = randomUUID();
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input)
     values ($1, $2, $3, $4, 'running', now() - ($5::int * interval '1 hour'), 'u1', '{}'::jsonb)`,
    [id, randomUUID(), sess, opts.executor, opts.startedHours]
  );
  return { run: id, sess };
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
    // Both windows skip a run whose step waits (0422): they read it.
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
    "delete from focus_sessions; delete from playbook_runs; delete from messages; delete from proposals; delete from automation_runs; delete from lifecycle_transition_outbox;"
  );
});

describe("the playbook run reaper's window follows who holds the run", () => {
  it("FAILS an IS run quiet for 3 hours and closes its session", async () => {
    const quiet = await run({
      executor: "is-agent",
      startedHours: 3,
      idleHours: 3,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(quiet.run)).toBe("failed");
    expect(closed).toEqual([quiet.sess]);
  });

  it("spares an IS run whose session moved within 2 hours, and an IS run younger than 2 hours", async () => {
    const moving = await run({
      executor: "is-agent",
      startedHours: 3,
      idleHours: 1,
    });
    const young = await run({
      executor: "is-agent",
      startedHours: 1,
      idleHours: 1,
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(moving.run)).toBe("running");
    expect(await statusOf(young.run)).toBe("running");
    expect(closed).toEqual([]);
  });

  it("an external agent's quiet run keeps its 24 hours: by executor, or by a key-client session", async () => {
    const external = await run({
      executor: "external-agent",
      startedHours: 3,
      idleHours: 3,
    });
    const keyClient = await run({
      executor: "is-agent",
      startedHours: 3,
      idleHours: 3,
      clientKey: "key:abc",
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(external.run)).toBe("running");
    expect(await statusOf(keyClient.run)).toBe("running");
    expect(closed).toEqual([]);
  });

  it("an IS run quiet for 3 hours whose session owes the person waits on them, never failed", async () => {
    const owing = await run({
      executor: "is-agent",
      startedHours: 3,
      idleHours: 3,
      outputs: [
        {
          label: "Stripe key",
          kind: "credential",
          owner: "human",
          owedSince: "2026-09-01T00:00:00.000Z",
        },
      ],
    });
    await handlePlaybookRunReaper();
    expect(await statusOf(owing.run)).toBe("waiting_on_you");
    expect(closed).toEqual([]);
  });
});
