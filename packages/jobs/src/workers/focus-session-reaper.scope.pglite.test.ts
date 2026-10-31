/**
 * The work reaper's scope (plan d679e92c C6), on PGlite: which sessions the
 * stale sweep may reach once `workReaperScope()` is ANDed in.
 *
 *  - a work session whose only open outcome is a GitHub PR waits on a merge:
 *    never staled, registered sweeper or not;
 *  - a RUN is left to its run once the api registers the lifecycle sweeper
 *    (its `runSessionWhere`, stubbed here with the run-key test); before the
 *    slot is filled, runs are staled as they always were.
 *
 * Real: `SESSION_IS_STALE`, `workReaperScope`, `onlyOpenPullRequestsWhere`.
 * Stubbed: the api's run predicate (its own kind tests cover it) and the
 * sweep. NOT covered: that `handleFocusSessionReaper` passes the scope to each
 * sweep — read the four `workReaperScope()` call sites.
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
import { sql } from "drizzle-orm";
import { and } from "@synap/database";
import { focusSessions, proposals, messages } from "@synap/database/schema";
import {
  SESSION_IS_STALE,
  registerSessionLifecycleSweeper,
  workReaperScope,
} from "./focus-session-reaper.js";
import { db } from "@synap/database";

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

async function session(opts: {
  metadata?: Record<string, unknown>;
  expectedOutputs?: unknown[];
}): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into focus_sessions (id, user_id, goal, status, metadata, expected_outputs, started_at, updated_at)
     values ($1, 'u1', 'g', 'active', $2::jsonb, $3::jsonb, now(), now() - interval '72 hours')`,
    [
      id,
      JSON.stringify(opts.metadata ?? {}),
      JSON.stringify(opts.expectedOutputs ?? []),
    ]
  );
  return id;
}

const PR_SLOT = {
  kind: "pull_request",
  label: "backend#603",
  ref: { url: "https://github.com/Synap-core/backend/pull/603" },
};

const reached = async () =>
  (
    await (db as any)
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(and(SESSION_IS_STALE, workReaperScope()))
  ).map((r: { id: string }) => r.id);

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  await h.client!.exec(ddlFor(proposals as unknown as PgTable));
  await h.client!.exec(ddlFor(messages as unknown as PgTable));
}, 120_000);

beforeEach(async () => {
  registerSessionLifecycleSweeper(null);
  await h.client!.exec("delete from focus_sessions;");
});

describe("workReaperScope", () => {
  it("never stales a session whose only open outcome is a pull request", async () => {
    const waiting = await session({ expectedOutputs: [PR_SLOT] });
    const working = await session({
      expectedOutputs: [PR_SLOT, { kind: "code", label: "the fix" }],
    });
    const plain = await session({});
    const ids = await reached();
    expect(ids).not.toContain(waiting);
    expect(ids).toContain(working);
    expect(ids).toContain(plain);
  });

  it("leaves runs to their run once the lifecycle sweeper is registered", async () => {
    const run = await session({ metadata: { automationRunId: randomUUID() } });
    const work = await session({});
    // Before the slot is filled (a jobs-only process): today's behaviour.
    expect(await reached()).toEqual(expect.arrayContaining([run, work]));
    registerSessionLifecycleSweeper({
      sweep: async () => ({
        metClosed: 0,
        heldOnMerge: 0,
        longStaleCancelled: 0,
        runsClosed: 0,
        failed: [],
      }),
      runSessionWhere: () =>
        sql`coalesce(${focusSessions.metadata} ? 'automationRunId', false)`,
    });
    const ids = await reached();
    expect(ids).not.toContain(run);
    expect(ids).toContain(work);
  });
});
