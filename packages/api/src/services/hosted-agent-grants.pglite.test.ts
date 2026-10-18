/**
 * An agent never exceeds its COMPUTER (MACHINE-IDENTITY-PLAN §2c) — through
 * the REAL grant doors on PGlite (every @synap/database table):
 *   - a mint for a hosted agent (`attachGrantsOrRevoke`) is clipped to the
 *     computer's live grants;
 *   - narrowing the computer (`apiKeys.setGrants`, the holder page) narrows
 *     its agents at once;
 *   - revoking the computer's key leaves its agents touching nothing;
 *   - an agent with no computer is never touched.
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
    EventRepository: class {
      async append() {
        return undefined;
      }
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { attachGrantsOrRevoke, liveGrantsOfKey } from "./key-grant.js";
import { apiKeysRouter } from "../routers/api-keys.js";

const HUMAN = "human-clip";
const DEVBOX = "machine-devbox";
const DEVBOX_CC = "agent-cc-on-devbox";
const MAC_CC = "agent-cc-no-host";

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
    const def = c.name === "created_at" ? " default now()" : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

async function addUser(
  id: string,
  agentType: string | null,
  host: string | null
) {
  await h.client!.query(
    `insert into users (id, email, user_type, agent_type, host_user_id, created_by_user_id,
       email_verified, timezone, locale, is_personal_agent, created_at, updated_at)
     values ($1, $1 || '@x', $2, $3, $4, $5, true, 'UTC', 'en', false, now(), now())`,
    [
      id,
      agentType ? "agent" : "human",
      agentType,
      host,
      agentType ? HUMAN : null,
    ]
  );
}
async function addKey(userId: string): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into api_keys (id, user_id, linked_user_id, key_name, key_prefix, key_hash,
       key_type, scope, is_active, usage_count, created_at)
     values ($1, $2, $3, 'k', 'synap_', $4, 'hub_inbound',
       '{hub-protocol.read,hub-protocol.write}', true, 0, now())`,
    [id, userId, HUMAN, `hash-${id}`]
  );
  return id;
}
const mint = (apiKeyId: string, principal: string, permissions: string[]) =>
  attachGrantsOrRevoke({
    apiKeyId,
    principalUserId: principal,
    onBehalfOf: HUMAN,
    grants: [{ permissions }],
    expiresAt: null,
    createdBy: HUMAN,
  });
const perms = async (keyId: string) =>
  (await liveGrantsOfKey(keyId)).flatMap((g) => g.permissions).sort();

let devboxKey: string;
let ccKey: string;
let macKey: string;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await addUser(HUMAN, null, null);
  await addUser(DEVBOX, "machine", null);
  await addUser(DEVBOX_CC, "claude-code", DEVBOX);
  await addUser(MAC_CC, "claude-code", null);
  devboxKey = await addKey(DEVBOX);
  ccKey = await addKey(DEVBOX_CC);
  macKey = await addKey(MAC_CC);
  await mint(devboxKey, DEVBOX, [
    "entity.read",
    "entity.create",
    "document.read",
  ]);
}, 120_000);

describe("an agent never exceeds its computer", () => {
  it("a mint for a hosted agent is clipped to the computer", async () => {
    await mint(ccKey, DEVBOX_CC, ["*"]);
    expect(await perms(ccKey)).toEqual([
      "document.read",
      "entity.create",
      "entity.read",
    ]);
  });

  it("asking for something the computer lacks keeps only the overlap", async () => {
    await mint(ccKey, DEVBOX_CC, ["entity.read", "entity.delete"]);
    expect(await perms(ccKey)).toEqual(["entity.read"]);
    await mint(ccKey, DEVBOX_CC, ["*"]);
  });

  it("an agent with no computer is untouched", async () => {
    await mint(macKey, MAC_CC, ["*"]);
    expect(await perms(macKey)).toEqual(["*"]);
  });

  it("narrowing the computer on its holder page narrows its agents at once", async () => {
    const caller = apiKeysRouter.createCaller({
      db: h.db,
      authenticated: true,
      userId: HUMAN,
      session: { identity: { id: HUMAN } },
    } as never);
    await caller.setGrants({
      keyId: devboxKey,
      grants: [{ permissions: ["entity.read"] }],
    });
    expect(await perms(ccKey)).toEqual(["entity.read"]);
    expect(await perms(macKey)).toEqual(["*"]);
  });

  it("revoking the computer's key leaves its agents touching nothing", async () => {
    const { clipHostedAgentGrants } = await import("./key-grant.js");
    await revokeApiKeys(h.db as never, {
      where: (await import("drizzle-orm")).eq(schema.apiKeys.id, devboxKey),
      reason: "test",
    });
    await clipHostedAgentGrants(DEVBOX, HUMAN);
    expect(await perms(ccKey)).toEqual([]);
    expect(await perms(macKey)).toEqual(["*"]);
  });
});
