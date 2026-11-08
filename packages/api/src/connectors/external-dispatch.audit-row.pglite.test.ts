/**
 * A completed external send leaves its audit row in `events`.
 *
 * Real door code end to end: `sendExternalMessage` → `recordExternalAction` →
 * `recordDomainMutation` → `auditLog` → the REAL `EventRepository.append`
 * (its `SynapEventSchema` validation included) on PGlite. Only the connector,
 * the worker lookup and the side-effect fan-out are stubbed.
 *
 * From 31 Jul to 2 Nov 2026 this row was never written: the outbound door
 * stamps `source: "external-dispatch"`, which `SynapEventSchema` did not
 * accept, so every append was a ZodError, logged and swallowed after the send
 * had gone ("recordExternalAction failed after a completed … audit row
 * missing", 21 times in 6 h on the founder's pod). What read those rows read
 * nothing: `diagnose(correlationId)` and a stage worker's daily send ceiling
 * (`countWorkerIrreversibleSentToday`, by `events.source` and session).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));
const sendMessage = vi.fn(async () => undefined);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      channels: actual.channels as never,
      events: actual.events as never,
    },
  });
  return {
    ...actual,
    db,
    getDb: async () => db,
    // `auditLog` builds `new EventRepository(sql)`: the postgres.js client,
    // of which `EventRepository` uses `.unsafe()` only.
    sql: {
      unsafe: async (text: string, params: unknown[]) =>
        (await client.query(text, params)).rows,
    },
    // No send in this file is a stage worker's (the ceiling has its own test).
    workerAutomationOfSession: async () => null,
  };
});

vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMessagingConnector: async () => ({ sendMessage }),
}));

vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { WORKER_SEND_EVENT_SOURCE } from "@synap/database";
import {
  sendExternalMessage,
  recordExternalAction,
} from "./external-dispatch.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

interface EventRow {
  type: string;
  source: string;
  user_id: string;
  correlation_id: string | null;
  session_id: string | null;
  workspace_id: string | null;
  data: { status?: string; target?: string };
}
const rowsFor = async (correlationId: string): Promise<EventRow[]> =>
  (
    await h.client!.query<EventRow>(
      `select * from events where correlation_id = $1`,
      [correlationId]
    )
  ).rows;

const SESSION = "11111111-1111-4111-8111-111111111111";
// `events.correlation_id` is a uuid: the door mints one per call.
const PROVIDER_CALL = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  await h.client!.exec(ddlFor(schema.channels as unknown as PgTable));
  await h.client!.exec(ddlFor(schema.events as unknown as PgTable));
  // The send door reads the session (a trial run's refusal, fail closed) and
  // its run (the guidance stamp).
  await h.client!.exec(ddlFor(schema.focusSessions as unknown as PgTable));
  await h.client!.exec(ddlFor(schema.playbookRuns as unknown as PgTable));
});

describe("a completed external send writes its audit row", () => {
  it("sendExternalMessage: one `.send.completed` row, source external-dispatch, with the session", async () => {
    const out = await sendExternalMessage({
      threadId: "thread-1",
      accountId: "acc-1",
      body: "hello",
      userId: "owner-1",
      workspaceId: WORKSPACE,
      sessionId: SESSION,
    });
    expect(out.success).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(out.correlationId).toBeTruthy();

    const rows = await rowsFor(out.correlationId!);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      type: "messaging.send.completed",
      user_id: "owner-1",
      workspace_id: WORKSPACE,
      session_id: SESSION,
    });
    expect(row!.data).toMatchObject({ status: "sent", target: "thread-1" });
    // What the worker send ceiling counts by: the same source and session.
    expect(row!.source).toBe(WORKER_SEND_EVENT_SOURCE);
  });

  it("recordExternalAction (the door triggerProviderAction calls) appends, never throws", async () => {
    await expect(
      recordExternalAction({
        channel: "nango",
        action: "action",
        userId: "owner-1",
        correlationId: PROVIDER_CALL,
        target: "github:POST /repos/x/issues",
        status: "sent",
        data: { method: "POST" },
      })
    ).resolves.toBeUndefined();
    const rows = await rowsFor(PROVIDER_CALL);
    expect(rows.map((r) => [r.type, r.source])).toEqual([
      ["nango.action.completed", WORKER_SEND_EVENT_SOURCE],
    ]);
  });
});
