/**
 * A key revoke is recorded as `apiKey.revoke`, a rotate as `apiKey.rotate` —
 * never `delete` / `update`, which timelines read as "Deleted API key" /
 * "Updated API key" for a key that was neither deleted nor edited.
 *
 * Driven through the REAL `apiKeys.revoke` / `apiKeys.rotate` procedures on
 * PGlite; only the event sinks are captured. The GATE keeps its governance
 * spelling (`apiKey` + `delete` / `update` is what the admin floors key on) —
 * this file pins the EVENT, not the gate.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  audits: [] as Array<Record<string, unknown>>,
  effects: [] as Array<Record<string, unknown>>,
  gates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
    h.gates.push(opts);
    return { granted: true };
  }),
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: async (opts: Record<string, unknown>) => {
    h.audits.push(opts);
    return null;
  },
}));

vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async (payload: Record<string, unknown>) => {
    h.effects.push(payload);
  },
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { apiKeysRouter } from "./api-keys.js";

const HUMAN = "human-1";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const caller = () =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: HUMAN,
  } as never);

async function addKey(): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into api_keys
       (id, user_id, key_name, key_prefix, key_hash, key_type, scope,
        is_active, usage_count, created_at)
     values ($1, $2, 'Vercel production', 'synap_hub_test_', $3, 'user_pat',
        '{hub-protocol.read}', true, 0, now())`,
    [id, HUMAN, `hash-${id}`]
  );
  return id;
}

/** `<subject>.<action>` of every event the procedure recorded. */
const recorded = () => [
  ...h.audits.map((a) => `audit:${a.subjectType}.${a.action}`),
  ...h.effects.map((e) => `effect:${e.subjectType}.${e.action}`),
];

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

beforeEach(() => {
  h.audits = [];
  h.effects = [];
  h.gates = [];
});

describe("API key lifecycle events say what happened", () => {
  it("revoke is recorded as apiKey.revoke (the gate keeps apiKey.delete)", async () => {
    const keyId = await addKey();
    await caller().revoke({ keyId });
    expect(recorded()).toEqual([
      "audit:apiKey.revoke",
      "effect:apiKey.revoke",
    ]);
    expect(h.gates.map((g) => `${g.subjectType}.${g.action}`)).toEqual([
      "apiKey.delete",
    ]);
  });

  it("rotate is recorded as apiKey.rotate (the gate keeps apiKey.update)", async () => {
    const keyId = await addKey();
    await caller().rotate({ keyId });
    expect(recorded()).toEqual([
      "audit:apiKey.rotate",
      "effect:apiKey.rotate",
    ]);
    expect(h.gates.map((g) => `${g.subjectType}.${g.action}`)).toEqual([
      "apiKey.update",
    ]);
  });
});
