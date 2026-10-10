/**
 * The recall SWEEP on PGlite: which sessions it recalls. The sweep is the
 * floor that makes "every start door gets a recall" true by derivation, so
 * the selection — all WHERE clause — is the thing under test. The runner is
 * the IoC slot (api-side), stubbed to record ids.
 *
 * Rows where naive rules disagree: a FAILED recall with attempts left and the
 * cool-off elapsed (retried) vs an EMPTY one (never retried); a failed one
 * inside its cool-off; one out of attempts; an agent write receipt; a session
 * older than the lookback; a closed one.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
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
import { focusSessions } from "@synap/database/schema";
import {
  handleSessionRecallSweep,
  registerSessionRecallRunner,
  RECALL_MAX_ATTEMPTS,
} from "./session-recall-worker.js";

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
  startedHoursAgo?: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into focus_sessions (id, user_id, goal, status, metadata, started_at, updated_at)
     values ($1, 'u1', 'g', $2, $3::jsonb, now() - ($4::int * interval '1 hour'), now())`,
    [
      id,
      opts.status ?? "active",
      JSON.stringify(opts.metadata ?? {}),
      opts.startedHoursAgo ?? 0,
    ]
  );
  return id;
}

const ago = (mins: number) =>
  new Date(Date.now() - mins * 60_000).toISOString();

describe("session recall sweep — selection", () => {
  const ids: Record<string, string> = {};
  const swept: string[] = [];

  beforeAll(async () => {
    await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
    registerSessionRecallRunner(async ({ sessionId }) => {
      swept.push(sessionId);
      return { status: "ok" };
    });
    ids.fresh = await session({});
    ids.paused = await session({ status: "paused" });
    ids.ok = await session({
      metadata: { recalledAt: ago(1), recalled: [{}] },
    });
    ids.empty = await session({
      metadata: { recalledAt: ago(60), recalled: [] },
    });
    ids.failedRetry = await session({
      metadata: {
        recalledAt: ago(30),
        recallError: { message: "x" },
        recallAttempts: 1,
      },
    });
    ids.failedCooling = await session({
      metadata: {
        recalledAt: ago(2),
        recallError: { message: "x" },
        recallAttempts: 1,
      },
    });
    ids.failedSpent = await session({
      metadata: {
        recalledAt: ago(60),
        recallError: { message: "x" },
        recallAttempts: RECALL_MAX_ATTEMPTS,
      },
    });
    ids.receipt = await session({ metadata: { source: "agent-write" } });
    // A start adopted the receipt: it keeps `source` for its provenance line.
    ids.adopted = await session({
      metadata: { source: "agent-write", adoptedAt: ago(1) },
    });
    ids.old = await session({ startedHoursAgo: 12 });
    ids.closed = await session({ status: "closed" });
    await handleSessionRecallSweep();
  });

  it("recalls never-recalled open sessions from any door", () => {
    expect(swept).toContain(ids.fresh);
    expect(swept).toContain(ids.paused);
  });

  it("recalls a receipt a start adopted — it is a session with a goal now", () => {
    expect(swept).toContain(ids.adopted);
  });

  it("retries a FAILED recall with attempts left after its cool-off — never an EMPTY one", () => {
    expect(swept).toContain(ids.failedRetry);
    expect(swept).not.toContain(ids.empty);
    expect(swept).not.toContain(ids.ok);
  });

  it("leaves cooling, spent, receipt, old and closed sessions alone", () => {
    for (const k of [
      "failedCooling",
      "failedSpent",
      "receipt",
      "old",
      "closed",
    ]) {
      expect(swept, k).not.toContain(ids[k]);
    }
    expect(swept).toHaveLength(4);
  });
});
