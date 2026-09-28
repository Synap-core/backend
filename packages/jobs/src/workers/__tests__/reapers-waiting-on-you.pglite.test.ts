/**
 * W2 calm — the reapers never close or stale a session that still owes the
 * person something; its run is marked `waiting_on_you`, never failed.
 *
 * On PGlite, through the REAL handlers and their REAL WHERE clauses — the
 * defect was entirely in SQL selection (census §3d: no reaper checked owed
 * slots). Every case pairs an owing session with an otherwise-identical
 * non-owing one, so a guard that skipped EVERYTHING would fail the other half.
 * The close itself is the IoC slot (`completeFocusSession` in api), stubbed to
 * record ids; run narration is stubbed (it reads tables this harness omits).
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
} from "@synap/database/schema";
import { handleFocusSessionReaper } from "../focus-session-reaper.js";
import { handleAutomationRunReaper } from "../automation-run-reaper.js";
import { handlePlaybookRunReaper } from "../playbook-run-reaper.js";
import {
  registerSessionCloser,
  closeSessionViaDoor,
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

/** A slot the agent handed to the person and nobody has closed. */
const OWED = [
  {
    label: "Stripe key",
    kind: "credential",
    owner: "human",
    owedSince: "2026-09-01T00:00:00.000Z",
  },
];
/** The same slot, done — the discriminating twin. */
const DONE = [{ ...OWED[0], status: "done" }];

async function session(opts: {
  idleHours: number;
  outputs?: unknown[];
  metadata?: Record<string, unknown>;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at)
     values ($1, 'u1', 'g', $2, $3::jsonb, $4::jsonb, now(), now() - ($5::int * interval '1 hour'))`,
    [
      id,
      opts.status ?? "active",
      JSON.stringify(opts.metadata ?? {}),
      JSON.stringify(opts.outputs ?? []),
      opts.idleHours,
    ]
  );
  return id;
}

const statusOf = async (table: string, id: string) =>
  (
    await q<{ status: string }>(`select status from ${table} where id = $1`, [
      id,
    ])
  ).rows[0]!.status;

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    automationRuns,
    automationStepRuns,
    playbookRuns,
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
    "delete from focus_sessions; delete from proposals; delete from automation_runs; delete from automation_step_runs; delete from playbook_runs;"
  );
});

describe("focus-session reaper", () => {
  it("never stales a quiet session that owes the person; stales its non-owing twin", async () => {
    const owing = await session({ idleHours: 30, outputs: OWED });
    const quiet = await session({ idleHours: 30, outputs: DONE });
    await handleFocusSessionReaper();
    expect(await statusOf("focus_sessions", owing)).toBe("active");
    expect(await statusOf("focus_sessions", quiet)).toBe("stale");
  });

  it("never closes an idle receipt that owes the person", async () => {
    const receipt = { kind: "agent-proposal-package", autoOpened: true };
    const owing = await session({
      idleHours: 3,
      outputs: OWED,
      metadata: receipt,
    });
    const done = await session({
      idleHours: 3,
      outputs: DONE,
      metadata: receipt,
    });
    await handleFocusSessionReaper();
    expect(closed).toEqual([done]);
    expect(closed).not.toContain(owing);
  });
});

describe("automation-run reaper", () => {
  async function staleRun(
    outputs: unknown[]
  ): Promise<{ run: string; sess: string }> {
    const run = randomUUID();
    await q(
      `insert into automation_runs (id, automation_id, status, started_at) values ($1, $2, 'running', now() - interval '2 hours')`,
      [run, randomUUID()]
    );
    const sess = await session({
      idleHours: 1,
      outputs,
      metadata: { automationRunId: run },
    });
    return { run, sess };
  }

  it("marks a stale run whose session owes the person WAITING, and leaves the session open", async () => {
    const owing = await staleRun(OWED);
    const orphan = await staleRun(DONE);
    await handleAutomationRunReaper();
    expect(await statusOf("automation_runs", owing.run)).toBe("waiting_on_you");
    expect(closed).not.toContain(owing.sess);
    // The twin is still an orphan: failed and closed, as before.
    expect(await statusOf("automation_runs", orphan.run)).toBe("failed");
    expect(closed).toContain(orphan.sess);
  });
  it("UNPARK: once the session no longer owes the person, the parked run leaves waiting (swept as usual)", async () => {
    const parked = await staleRun(OWED);
    await handleAutomationRunReaper();
    expect(await statusOf("automation_runs", parked.run)).toBe(
      "waiting_on_you"
    );
    // The person answers.
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [parked.sess, JSON.stringify(DONE)]
    );
    await handleAutomationRunReaper();
    expect(await statusOf("automation_runs", parked.run)).toBe("failed");
  });

  it("a CLOSED session with a leftover owed slot never parks its run", async () => {
    const run = randomUUID();
    await q(
      `insert into automation_runs (id, automation_id, status, started_at) values ($1, $2, 'running', now() - interval '2 hours')`,
      [run, randomUUID()]
    );
    await session({
      idleHours: 1,
      outputs: OWED,
      status: "closed",
      metadata: { automationRunId: run },
    });
    await handleAutomationRunReaper();
    expect(await statusOf("automation_runs", run)).toBe("failed");
  });
});

describe("playbook-run reaper", () => {
  async function staleRun(
    outputs: unknown[]
  ): Promise<{ run: string; sess: string }> {
    const sess = await session({ idleHours: 30, outputs, status: "stale" });
    const run = randomUUID();
    await q(
      `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input)
       values ($1, $2, $3, 'external-agent', 'running', now() - interval '30 hours', 'u1', '{}'::jsonb)`,
      [run, randomUUID(), sess]
    );
    return { run, sess };
  }

  it("marks a quiet run whose session owes the person WAITING, never failed; the twin fails", async () => {
    const owing = await staleRun(OWED);
    const orphan = await staleRun(DONE);
    await handlePlaybookRunReaper();
    expect(await statusOf("playbook_runs", owing.run)).toBe("waiting_on_you");
    expect(closed).not.toContain(owing.sess);
    expect(await statusOf("playbook_runs", orphan.run)).toBe("failed");
    expect(closed).toContain(orphan.sess);
  });
  it("UNPARK: an answered session releases its parked run back to the sweeps", async () => {
    const parked = await staleRun(OWED);
    await handlePlaybookRunReaper();
    expect(await statusOf("playbook_runs", parked.run)).toBe("waiting_on_you");
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [parked.sess, JSON.stringify(DONE)]
    );
    await handlePlaybookRunReaper();
    expect(await statusOf("playbook_runs", parked.run)).toBe("failed");
  });

  it("a CLOSED session with a leftover owed slot never parks its run", async () => {
    const sess = await session({
      idleHours: 30,
      outputs: OWED,
      status: "closed",
    });
    const run = randomUUID();
    await q(
      `insert into playbook_runs (id, playbook_id, session_id, executor, status, started_at, created_by, input)
       values ($1, $2, $3, 'external-agent', 'running', now() - interval '30 hours', 'u1', '{}'::jsonb)`,
      [run, randomUUID(), sess]
    );
    await handlePlaybookRunReaper();
    expect(await statusOf("playbook_runs", run)).toBe("failed");
  });
});

describe("closeSessionViaDoor — the executor's end-of-run close", () => {
  it("returns null and never reaches the close door for a session that owes the person", async () => {
    const owing = await session({ idleHours: 0, outputs: OWED });
    const clear = await session({ idleHours: 0, outputs: DONE });
    expect(
      await closeSessionViaDoor({ sessionId: owing, userId: "u1" })
    ).toBeNull();
    expect(
      await closeSessionViaDoor({ sessionId: clear, userId: "u1" })
    ).not.toBeNull();
    expect(closed).toEqual([clear]);
  });

  it("a retired slot no longer holds the session open (the predicate is THE owed one)", async () => {
    const retired = await session({
      idleHours: 0,
      outputs: [{ ...OWED[0], retiredAt: "2026-09-02T00:00:00.000Z" }],
    });
    expect(
      await closeSessionViaDoor({ sessionId: retired, userId: "u1" })
    ).not.toBeNull();
  });
});
