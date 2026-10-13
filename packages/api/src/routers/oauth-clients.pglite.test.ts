/**
 * `oauthClients.*` — the pod admin's inventory of the clients its own OAuth
 * server registered, through the REAL router on PGlite.
 *
 * Keys are seeded with the `instance_id` the token endpoint writes
 * (`oauthKeyInstanceId`), so the read here and the write there share one
 * spelling. Pinned:
 *   - adminList: a client a person connected is listed with its redirect
 *     host, key counts, last use and the person; a registration nobody
 *     consented to is left out unless asked for; a member is refused;
 *   - adminRevoke: every live key of THAT client stops (another client's
 *     key does not), an unexchanged code is burned, the client row stays;
 *     an agent key linked to an admin is refused;
 *   - the instance id round-trips (`parseOauthKeyInstanceId`).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  admins: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { oauthClientsRouter } from "./oauth-clients.js";
import { redirectHosts } from "../services/oauth-client-inventory.js";
import { oauthKeyInstanceId, parseOauthKeyInstanceId } from "./oauth/config.js";

const ADMIN = "human-admin";
const MEMBER = "human-member";
const AGENT = "agent-claude-direct";
const CLAUDE = "dcr_claude_1";
const OTHER = "dcr_other_2";
const UNUSED = "dcr_unused_3";

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
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

const caller = (userId: string, agentUserId?: string) =>
  oauthClientsRouter.createCaller({
    authenticated: true,
    userId,
    session: { id: "s" },
    ...(agentUserId ? { agentUserId } : {}),
  } as never);

async function mintFor(clientId: string, person: string, lastUsed?: string) {
  const id = randomUUID();
  await q(
    `insert into api_keys (id, user_id, linked_user_id, instance_id, is_active, key_type, key_name, key_prefix, key_hash, scope, usage_count, last_used_at)
     values ($1, $2, $3, $4, true, 'hub_inbound', 'Claude Web Direct Hub Key', 'synap_hub_live_', 'h', '{mcp.read,mcp.write}', 3, $5)`,
    [id, AGENT, person, oauthKeyInstanceId(clientId, person), lastUsed ?? null]
  );
  return id;
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  h.admins.add(ADMIN);
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'admin@x', 'Ada Admin', 'human'), ($2, 'marie@x', 'Marie', 'human')`,
    [ADMIN, MEMBER]
  );
  for (const [clientId, name, created] of [
    [CLAUDE, "Claude", "2026-10-02T00:00:00Z"],
    [OTHER, "Other client", "2026-10-01T00:00:00Z"],
    [UNUSED, "Never consented", "2026-10-03T00:00:00Z"],
  ])
    await q(
      `insert into oauth_clients (client_id, client_name, redirect_uris, scopes, created_at)
       values ($1, $2, '{https://claude.ai/api/mcp/auth_callback}', '{mcp.read,mcp.write}', $3)`,
      [clientId, name, created]
    );
  await mintFor(CLAUDE, MEMBER, "2026-10-10T09:00:00Z");
  await mintFor(OTHER, ADMIN);
  await q(
    `insert into oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, expires_at)
     values ('h1', $1, $2, 'https://claude.ai/api/mcp/auth_callback', '{mcp.read}', 'c', now() + interval '5 minutes')`,
    [CLAUDE, MEMBER]
  );
}, 120_000);

describe("oauth instance id", () => {
  it("round-trips, and reads nothing else", () => {
    expect(
      parseOauthKeyInstanceId(oauthKeyInstanceId("dcr_a-b", "u-1"))
    ).toEqual({ clientId: "dcr_a-b", userId: "u-1" });
    expect(parseOauthKeyInstanceId("machine:abc")).toBeNull();
    expect(parseOauthKeyInstanceId("oauth:dcr_a:")).toBeNull();
    expect(parseOauthKeyInstanceId(null)).toBeNull();
  });

  it("redirect hosts are unique and skip what is not a URL", () => {
    expect(
      redirectHosts(["https://claude.ai/a", "https://claude.ai/b", "not a url"])
    ).toEqual(["claude.ai"]);
  });
});

describe("oauthClients.adminList / adminGet", () => {
  it("lists connected clients with host, keys, last use and the person", async () => {
    const list = await caller(ADMIN).adminList();
    expect(list.map((c) => c.clientId)).toEqual([CLAUDE, OTHER]);
    expect(list[0]).toMatchObject({
      clientName: "Claude",
      redirectHosts: ["claude.ai"],
      mintedKeys: 1,
      activeKeys: 1,
      people: [{ id: MEMBER, name: "Marie", active: true }],
    });
    expect(list[0]!.lastUsedAt?.toISOString()).toBe("2026-10-10T09:00:00.000Z");
    expect(list[1]!.lastUsedAt).toBeNull();
  });

  it("a registration nobody consented to is listed only on request", async () => {
    const all = await caller(ADMIN).adminList({ includeUnused: true });
    expect(all.map((c) => c.clientId)).toContain(UNUSED);
  });

  it("adminGet carries the client's keys; an unknown client is NOT_FOUND", async () => {
    const one = await caller(ADMIN).adminGet({ clientId: CLAUDE });
    expect(one.keys).toHaveLength(1);
    expect(one.keys[0]).toMatchObject({ personId: MEMBER, isActive: true });
    await expect(
      caller(ADMIN).adminGet({ clientId: "dcr_missing" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a member is refused", async () => {
    await expect(caller(MEMBER).adminList()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      caller(MEMBER).adminRevoke({ clientId: CLAUDE })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("oauthClients.adminRevoke", () => {
  it("refuses an agent key linked to a pod admin, and revokes nothing", async () => {
    await expect(
      caller(ADMIN, AGENT).adminRevoke({ clientId: CLAUDE })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const live = await q<{ n: number }>(
      `select count(*)::int as n from api_keys where is_active`
    );
    expect(live[0]!.n).toBe(2);
  });

  it("stops that client's keys only, burns its waiting code, keeps the row", async () => {
    expect(await caller(ADMIN).adminRevoke({ clientId: CLAUDE })).toEqual({
      clientId: CLAUDE,
      revokedKeys: 1,
    });
    const keys = await q<{ instance_id: string; is_active: boolean }>(
      `select instance_id, is_active from api_keys order by instance_id`
    );
    expect(
      keys.map((k) => [
        parseOauthKeyInstanceId(k.instance_id)!.clientId,
        k.is_active,
      ])
    ).toEqual([
      [CLAUDE, false],
      [OTHER, true],
    ]);
    const codes = await q<{ consumed_at: Date | null }>(
      `select consumed_at from oauth_authorization_codes`
    );
    expect(codes[0]!.consumed_at).not.toBeNull();
    const [claude] = await caller(ADMIN).adminList();
    expect(claude).toMatchObject({
      clientId: CLAUDE,
      mintedKeys: 1,
      activeKeys: 0,
      people: [{ id: MEMBER, active: false }],
    });
    // Idempotent: nothing left to stop.
    expect(
      (await caller(ADMIN).adminRevoke({ clientId: CLAUDE })).revokedKeys
    ).toBe(0);
  });
});
