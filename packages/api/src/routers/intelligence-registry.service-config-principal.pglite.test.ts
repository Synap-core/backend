/**
 * `intelligenceRegistry.getServiceConfig` reads the KEY PRINCIPAL's service
 * bootstrap blob — never the linked human's vault.
 *
 * For an agent key minted by /setup/agent (`api_keys.user_id` = the agent,
 * `linked_user_id` = the human), every transport remaps `ctx.userId` to the
 * HUMAN (`resolveKeyIdentity`). The endpoint used to read
 * `secrets WHERE user_id = ctx.userId`, so any agent key with
 * `hub-protocol.read` received its human's most recent server-mode secret,
 * decrypted.
 *
 * Driven through the REAL procedure with the context the Hono hub middleware
 * hands tRPC (authenticated + scopes + apiKeyId short-circuit), on PGlite with
 * every @synap/database table created. Stubbed: only the db handle.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

process.env.VAULT_SERVER_KEY ??= "a".repeat(64);

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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { encryptConfig } from "@synap/database";
import { intelligenceRegistryRouter } from "./intelligence-registry.js";

const HUMAN = "human-1";
const AGENT = "agent-1";
const AGENT_KEY = randomUUID();

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

/** The context the hub REST middleware builds for an agent key. */
const agentKeyCaller = () =>
  intelligenceRegistryRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: HUMAN, // remapped by resolveKeyIdentity
    agentUserId: AGENT,
    apiKeyId: AGENT_KEY,
    apiKeyName: "claude-code",
    scopes: ["hub-protocol.read", "hub-protocol.write"],
  } as never);

async function addSecret(
  userId: string,
  serviceId: string | null,
  config: Record<string, string>
) {
  const blob = encryptConfig(config);
  await h.client!.query(
    `insert into secrets
       (id, user_id, service_id, name, type, encryption_mode,
        encrypted_data, iv, auth_tag, created_at, updated_at)
     values ($1, $2, $3, 'x', 'api_key', 'server', $4, $5, $6, now(), now())`,
    [randomUUID(), userId, serviceId, blob.encryptedData, blob.iv, blob.authTag]
  );
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await h.client!.query(
    `insert into api_keys
       (id, user_id, key_name, key_prefix, key_hash, key_type, scope,
        linked_user_id, is_active, usage_count, created_at)
     values ($1, $2, 'claude-code', 'synap_hub_test_', 'h', 'hub_inbound',
        '{hub-protocol.read,hub-protocol.write}', $3, true, 0, now())`,
    [AGENT_KEY, AGENT, HUMAN]
  );
});

beforeEach(async () => {
  await h.client!.exec(`delete from secrets;`);
});

describe("getServiceConfig — reads the key principal, never the linked human", () => {
  it("does not hand an agent key its human's vault secret", async () => {
    await addSecret(HUMAN, null, { password: "human-bank-password" });

    await expect(agentKeyCaller().getServiceConfig()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("does not hand over the human's service blob either", async () => {
    await addSecret(HUMAN, "openclaw-human", { SYNAP_HUB_API_KEY: "human" });

    await expect(agentKeyCaller().getServiceConfig()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns the key principal's own service bootstrap blob", async () => {
    await addSecret(HUMAN, null, { password: "human-bank-password" });
    await addSecret(AGENT, "openclaw-agent1", { SYNAP_HUB_API_KEY: "mine" });

    await expect(agentKeyCaller().getServiceConfig()).resolves.toEqual({
      SYNAP_HUB_API_KEY: "mine",
    });
  });
});
