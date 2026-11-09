/**
 * `system.listAuditLogs({ presenceMissing })`: the approvals and changes that
 * went through without a proof of presence, the list the Security card's
 * counts open.
 *
 * Driven through the REAL procedure → the REAL `EventRepository.searchEvents`
 * → SQL on PGlite. The rows rule out the wrong rules:
 *  - without the lens, `presence.missing` never shows (its subject is outside
 *    the audit subject types and it has no `completed` phase);
 *  - with the lens, ONLY `presence.missing` shows, not the audit rows beside it;
 *  - the kinds interleave in time, so a kind filtered after paging would
 *    return another kind's row (or none) on the one-row pages asked here.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  const EventRepository = actual.EventRepository as new (
    sql: unknown
  ) => unknown;
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: new EventRepository({
      unsafe: async (sql: string, params: unknown[]) =>
        (await client.query(sql, params)).rows,
    }),
  };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { workspaces, workspaceMembers, users } from "@synap/database/schema";
import { systemRouter } from "./system.js";

const ADMIN = "pod-admin-1";
const POD_ADMIN_WS = randomUUID();

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

const admin = () =>
  systemRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: ADMIN,
    workspaceId: null,
  } as never);

const FROM = "2026-11-01T00:00:00.000Z";
const TO = "2026-11-06T00:00:00.000Z";

beforeAll(async () => {
  for (const t of [workspaces, workspaceMembers, users])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.exec(`create table events (
    id text primary key,
    type text not null,
    subject_type text,
    subject_id text,
    user_id text,
    workspace_id text,
    data jsonb,
    metadata jsonb,
    source text,
    correlation_id text,
    timestamp timestamptz not null
  );`);
  await h.client!.query(
    `insert into users (id, email, name, user_type, created_at)
     values ($1, $2, $1, 'human', now())`,
    [ADMIN, `${ADMIN}@pod.example`]
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, system_slug, created_at, updated_at)
     values ($1, 'Pod admin', $2, '{}'::jsonb, 'pod-admin', now(), now())`,
    [POD_ADMIN_WS, ADMIN]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1, $2, $3, 'owner')`,
    [randomUUID(), POD_ADMIN_WS, ADMIN]
  );
  // id, type, subject type, proposalType, timestamp (newest first)
  const rows: Array<[string, string, string, string, string]> = [
    ["a1", "api_keys.create.completed", "api_keys", "", "2026-11-05T12:00:00Z"],
    [
      "m1",
      "presence.missing",
      "proposal",
      "agent/connect",
      "2026-11-05T10:00:00Z",
    ],
    [
      "m3",
      "presence.missing",
      "presence_request",
      "key_request",
      "2026-11-05T09:30:00Z",
    ],
    [
      "m2",
      "presence.missing",
      "proposal",
      "agent/connect",
      "2026-11-05T09:00:00Z",
    ],
    [
      "m4",
      "presence.missing",
      "presence_request",
      "apiKeys.create",
      "2026-10-20T09:00:00Z",
    ],
    [
      "p1",
      "presence.mode_changed",
      "presence_mode",
      "",
      "2026-11-04T09:00:00Z",
    ],
  ];
  for (const [id, type, subjectType, kind, ts] of rows)
    await h.client!.query(
      `insert into events (id, type, subject_type, subject_id, user_id, data, source, timestamp)
       values ($1, $2, $3, $1, $4,
               case when $5::text = '' then '{}'::jsonb
                    else jsonb_build_object('proposalType', $5::text) end,
               'api', $6)`,
      [id, type, subjectType, ADMIN, kind, ts]
    );
});

const ids = (r: { events: Array<{ id: string }> }) => r.events.map((e) => e.id);

describe("listAuditLogs — the went-through-without-a-proof lens", () => {
  it("without the lens, presence.missing never shows", async () => {
    const r = await admin().listAuditLogs({ fromDate: FROM, toDate: TO });
    expect(ids(r)).toEqual(["a1"]);
  });

  it("with the lens, only presence.missing rows in the date range", async () => {
    const r = await admin().listAuditLogs({
      fromDate: FROM,
      toDate: TO,
      presenceMissing: {},
    });
    expect(ids(r)).toEqual(["m1", "m3", "m2"]);
    expect(r.events.map((e) => e.eventType)).toEqual([
      "presence.missing",
      "presence.missing",
      "presence.missing",
    ]);
  });

  it("a kind is filtered before paging: the one-row page holds that kind", async () => {
    const r = await admin().listAuditLogs({
      fromDate: FROM,
      toDate: TO,
      presenceMissing: { kind: "key_request" },
      limit: 1,
    });
    expect(ids(r)).toEqual(["m3"]);
  });

  it("pages within the kind", async () => {
    const r = await admin().listAuditLogs({
      fromDate: FROM,
      toDate: TO,
      presenceMissing: { kind: "agent/connect" },
      limit: 1,
      offset: 1,
    });
    expect(ids(r)).toEqual(["m2"]);
  });

  it("the date range still narrows the lens", async () => {
    const r = await admin().listAuditLogs({
      fromDate: "2026-10-01T00:00:00.000Z",
      toDate: TO,
      presenceMissing: { kind: "apiKeys.create" },
    });
    expect(ids(r)).toEqual(["m4"]);
    const inRange = await admin().listAuditLogs({
      fromDate: FROM,
      toDate: TO,
      presenceMissing: { kind: "apiKeys.create" },
    });
    expect(ids(inRange)).toEqual([]);
  });
});
