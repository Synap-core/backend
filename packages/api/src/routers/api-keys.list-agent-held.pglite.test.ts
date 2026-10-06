/**
 * `apiKeys.list` / `apiKeys.revoke` see the keys an agent holds FOR you (D6,
 * 2026-10-06 centralisation audit).
 *
 * THE DEFECT. Agent and OAuth-client keys are owned by the AGENT user
 * (`api_keys.user_id` = agent, `linked_user_id` = the human). `list` floored on
 * `user_id = me`, so /my-connections showed none of them, and `revoke` answered
 * NOT_FOUND for them — the human could neither see nor stop the credentials
 * acting in their name.
 *
 * Driven through the REAL procedures on PGlite (every @synap/database table).
 * Stubbed: the db handle, and the governance gate (a human revoking their own
 * agent's key is granted — the gate's ladder is pinned elsewhere).
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
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { apiKeysRouter } from "./api-keys.js";

const HUMAN = "human-1";
const AGENT = "agent-1";
const STRANGER = "stranger-1";
const OWN_KEY = randomUUID();
const AGENT_KEY = randomUUID();
const STRANGER_KEY = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const caller = (userId: string) =>
  apiKeysRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId,
  } as never);

async function addKey(id: string, userId: string, linkedUserId: string | null) {
  await h.client!.query(
    `insert into api_keys
       (id, user_id, key_name, key_prefix, key_hash, key_type, scope,
        linked_user_id, is_active, usage_count, created_at)
     values ($1, $2, $4, 'synap_hub_test_', $5, 'hub_inbound',
        '{hub-protocol.read}', $3, true, 0, now())`,
    [id, userId, linkedUserId, `key-${id}`, `hash-${id}`]
  );
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await addKey(OWN_KEY, HUMAN, null);
  await addKey(AGENT_KEY, AGENT, HUMAN);
  await addKey(STRANGER_KEY, STRANGER, null);
});

describe("apiKeys.list — the keys you hold and the keys held for you", () => {
  it("lists your key and your agent's key, never a stranger's", async () => {
    const keys = await caller(HUMAN).list();
    expect(keys.map((k) => k.id).sort()).toEqual([AGENT_KEY, OWN_KEY].sort());
    expect(keys.find((k) => k.id === AGENT_KEY)?.heldByAgent).toBe(true);
    expect(keys.find((k) => k.id === OWN_KEY)?.heldByAgent).toBe(false);
  });
});

describe("apiKeys.revoke — you can stop a key held for you", () => {
  it("revokes your agent's key", async () => {
    await expect(
      caller(HUMAN).revoke({ keyId: AGENT_KEY })
    ).resolves.toMatchObject({ status: "revoked" });
    const { rows } = await h.client!.query<{ is_active: boolean }>(
      `select is_active from api_keys where id = $1`,
      [AGENT_KEY]
    );
    expect(rows[0].is_active).toBe(false);
  });

  it("still refuses a stranger's key", async () => {
    await expect(
      caller(HUMAN).revoke({ keyId: STRANGER_KEY })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
