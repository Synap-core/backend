/**
 * PER-SUBJECT COOLDOWN — a subject whose latest run of a playbook FAILED
 * recently is not re-dispatched by the subject-idempotent (scheduled) path.
 *
 * The incident: the reaper failed each child run at 24h, closed its session,
 * and the next daily cron found no in-flight session and started a fresh run
 * for the same company — which failed the same way, every day.
 *
 * Real: `runPlaybook` → `executeSingleRun` → the cooldown query, on PGlite.
 * `instantiateSession` (the first act of a run that proceeds) throws a
 * sentinel, so "the run proceeded" is observed, not inferred.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const PROCEEDED = "COOLDOWN_TEST: run proceeded to instantiateSession";

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
  const db = drizzle(client, {
    schema: { focusSessions: actual.focusSessions as never },
  });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../playbook-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../playbook-lifecycle.js")>();
  return {
    ...actual,
    resolveRunnablePlaybook: vi.fn(async () => ({
      id: PLAYBOOK,
      metadata: {},
      inputStrategy: null,
      goalTemplate: "Advance {{subject}}",
    })),
    instantiateSession: vi.fn(async () => {
      throw new Error(PROCEEDED);
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, playbookRuns } from "@synap/database/schema";
import { runPlaybook } from "../run-playbook.js";
import { AI_DISPATCH_GUARDRAILS } from "@synap-core/types/automations";

const PLAYBOOK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUBJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_SUBJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

/** A CLOSED session for (playbook, subject) with one run that ended `hoursAgo`. */
async function pastRun(opts: {
  subject?: string;
  status: string;
  hoursAgo: number;
}): Promise<string> {
  const sessionId = randomUUID();
  const runId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, playbook_id, subject_entity_id, started_at, updated_at)
     values ($1, 'u1', 'g', 'closed', $2, $3, now() - ($4::int * interval '1 hour'), now())`,
    [sessionId, PLAYBOOK, opts.subject ?? SUBJECT, opts.hoursAgo + 1]
  );
  await q(
    `insert into playbook_runs (id, playbook_id, session_id, status, started_at, completed_at)
     values ($1, $2, $3, $4, now() - ($5::int * interval '1 hour') - interval '1 minute', now() - ($5::int * interval '1 hour'))`,
    [runId, PLAYBOOK, sessionId, opts.status, opts.hoursAgo]
  );
  return runId;
}

const INPUT = {
  playbookId: PLAYBOOK,
  workspaceId: "ws-1",
  userId: "u1",
  subjectId: SUBJECT,
  idempotentBySubject: true,
};

const outcome = () =>
  runPlaybook(INPUT as never).then(
    (r) => ({ skipped: r.skipped ?? null, run: r.run }),
    (e: Error) => ({ error: e.message })
  );

beforeAll(async () => {
  for (const t of [focusSessions, playbookRuns]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs;"
  );
});

describe("runPlaybook subject-idempotency — cooldown after a failed run", () => {
  it("skips with `cooling_down` when the subject's latest run FAILED within the window", async () => {
    await pastRun({ status: "failed", hoursAgo: 2 });
    expect(await outcome()).toEqual({ skipped: "cooling_down", run: null });
  });

  it("proceeds once the window has passed", async () => {
    await pastRun({
      status: "failed",
      hoursAgo: AI_DISPATCH_GUARDRAILS.failedSubjectCooldownHours + 1,
    });
    expect(await outcome()).toEqual({ error: PROCEEDED });
  });

  it("proceeds when the latest run COMPLETED (an older failure does not count)", async () => {
    await pastRun({ status: "failed", hoursAgo: 5 });
    await pastRun({ status: "completed", hoursAgo: 1 });
    expect(await outcome()).toEqual({ error: PROCEEDED });
  });

  it("is per subject: another subject's failure does not cool this one", async () => {
    await pastRun({ subject: OTHER_SUBJECT, status: "failed", hoursAgo: 1 });
    expect(await outcome()).toEqual({ error: PROCEEDED });
  });

  it("a manual run (no idempotentBySubject) is never cooled", async () => {
    await pastRun({ status: "failed", hoursAgo: 1 });
    const r = await runPlaybook({
      ...INPUT,
      idempotentBySubject: false,
    } as never).then(
      () => "returned",
      (e: Error) => e.message
    );
    expect(r).toBe(PROCEEDED);
  });
});
