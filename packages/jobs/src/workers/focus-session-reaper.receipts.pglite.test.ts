/**
 * The receipt closer, on PGlite: which sessions the hourly reaper CLOSES.
 *
 * Real: `closeIdleReceipts` → the `RECEIPT_IS_DONE` SQL. The close itself is
 * the IoC slot (`completeFocusSession` in api), stubbed to record ids — the
 * point here is the selection, which is all WHERE clause.
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
import { focusSessions, proposals } from "@synap/database/schema";
import { closeIdleReceipts } from "./focus-session-reaper.js";
import { registerSessionCloser } from "../utils/session-close.js";

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
  metadata: Record<string, unknown>;
  idleHours: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, metadata, started_at, updated_at)
     values ($1, 'u1', 'g', $2, $3::jsonb, now(), now() - ($4::int * interval '1 hour'))`,
    [id, opts.status ?? "active", JSON.stringify(opts.metadata), opts.idleHours]
  );
  return id;
}

async function proposal(sessionId: string, status: string, ageHours: number) {
  await q(
    `insert into proposals (id, session_id, status, created_at) values ($1, $2, $3, now() - ($4::int * interval '1 hour'))`,
    [randomUUID(), sessionId, status, ageHours]
  );
}

const RECEIPT = {
  kind: "agent-proposal-package",
  autoOpened: true,
  clientKey: "key:A",
};

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  await h.client!.exec(ddlFor(proposals as unknown as PgTable));
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
  await h.client!.exec("delete from focus_sessions; delete from proposals;");
});

describe("closeIdleReceipts", () => {
  it("closes an idle receipt whose proposals are all decided", async () => {
    const done = await session({ metadata: RECEIPT, idleHours: 3 });
    await proposal(done, "approved", 3);
    expect(await closeIdleReceipts()).toBe(1);
    expect(closed).toEqual([done]);
  });

  it("never closes a real work session, however idle", async () => {
    await session({ metadata: {}, idleHours: 30 });
    // An adopted receipt lost its marker: it is work now.
    await session({
      metadata: { clientKey: "key:A", adoptedAt: "x" },
      idleHours: 30,
    });
    expect(await closeIdleReceipts()).toBe(0);
  });

  it("keeps a receipt open while a proposal in it is pending", async () => {
    const pending = await session({ metadata: RECEIPT, idleHours: 3 });
    await proposal(pending, "pending", 3);
    expect(await closeIdleReceipts()).toBe(0);
  });

  it("keeps a receipt open while writes are still arriving", async () => {
    const busy = await session({ metadata: RECEIPT, idleHours: 3 });
    await proposal(busy, "auto_approved", 0);
    const fresh = await session({ metadata: RECEIPT, idleHours: 0 });
    expect(await closeIdleReceipts()).toBe(0);
    expect(closed).not.toContain(busy);
    expect(closed).not.toContain(fresh);
  });
});
