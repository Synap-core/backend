/**
 * S2 — a webhook subscription is tied to the API key that created it.
 *
 * Through the REAL hub auth door and the REAL route handlers, on PGlite (the
 * key's grant is read by `GrantRepository.resolveForKey`, the subscriptions
 * are real rows). Mocked: the bcrypt key lookup (`apiKeyService` — the bearer
 * names the key record), the Kratos session read, guest containment.
 *
 *  - A key's POST records the key (`api_key_id`); a session's records none.
 *  - A key LISTS and DELETES only its own subscriptions; a session sees and
 *    deletes every one of the owner's (today's behaviour).
 *
 * Rows rule out: a create that drops the key id, a listing filtered on owner
 * only (K2's and the session's rows), a delete that lets one key remove
 * another's row, and a session that loses sight of key-bound rows.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  keys: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: async (bearer: string) => {
      const record = h.keys.get(bearer);
      return record ? { status: "valid", record } : { status: "not_found" };
    },
    recordKeyUse: () => {},
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: async () => false,
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: async () => null,
}));
vi.mock("@synap/auth", () => ({
  getSession: async () => ({ identity: { id: OWNER } }),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { HubHono, HubVariables } from "./_shared.js";

const { hubAuthMiddleware } = await import("../_middleware/auth.js");
const { registerWebhooksRoutes } = await import("./webhooks.js");
// The session surface (Reactions tab): tRPC `integrations.list`.
const { webhooksRouter } = await import("../../webhooks.js");

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

const OWNER = "owner-human";
const AGENT = "agent-principal";
const K1 = randomUUID();
const K2 = randomUUID();
const RW = ["hub-protocol.read", "hub-protocol.write"];

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

function keyRecord(id: string) {
  return {
    id,
    userId: AGENT,
    linkedUserId: OWNER,
    parentKeyId: null,
    scope: RW,
    keyType: "hub_inbound",
    workspaceId: null,
    expiresAt: null,
  };
}

async function grantKey(keyId: string, permissions: string[]) {
  await q(
    `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, created_by, created_at)
     values ($1,$2,$3,$4,$5,$4, now())`,
    [randomUUID(), keyId, AGENT, OWNER, permissions]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // The defaults the route's insert relies on (the generic DDL has none).
  await h.client!.exec(`
    alter table webhook_subscriptions alter column id set default gen_random_uuid();
    alter table webhook_subscriptions alter column created_at set default now();
    alter table webhook_subscriptions alter column active set default true;
  `);
  await q(
    `insert into users (id, email, user_type) values ($1,'o@x.test','human')`,
    [OWNER]
  );
  await q(
    `insert into users (id, email, user_type) values ($1,'a@x.test','agent')`,
    [AGENT]
  );
  for (const k of [K1, K2]) {
    await q(
      `insert into api_keys (id, user_id, key_name, is_active) values ($1,$2,'k',true)`,
      [k, AGENT]
    );
    h.keys.set(`synap_${k}`, keyRecord(k));
    await grantKey(k, ["*"]);
  }
});

beforeEach(async () => {
  await q(`delete from webhook_subscriptions`);
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerWebhooksRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

type Caller = { key: string } | "session";
const auth = (who: Caller): Record<string, string> =>
  who === "session"
    ? { "x-session-token": "kratos-session" }
    : { authorization: `Bearer synap_${who.key}` };

async function create(who: Caller): Promise<string> {
  const res = await app().request("/api/hub/webhooks", {
    method: "POST",
    headers: { ...auth(who), "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://hook.example/x",
      eventTypes: ["entity.update.completed"],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
async function list(who: Caller): Promise<string[]> {
  const res = await app().request("/api/hub/webhooks", { headers: auth(who) });
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((s) => s.id).sort();
}
const remove = (who: Caller, id: string) =>
  app().request(`/api/hub/webhooks/${id}`, {
    method: "DELETE",
    headers: auth(who),
  });
async function keyOf(id: string): Promise<unknown> {
  const r = await q<{ api_key_id: unknown }>(
    `select api_key_id from webhook_subscriptions where id = $1`,
    [id]
  );
  return r.rows[0]?.api_key_id;
}

describe("POST /webhooks — the subscription names its creating key", () => {
  it("a key's subscription records that key", async () => {
    const id = await create({ key: K1 });
    expect(await keyOf(id)).toBe(K1);
  });

  it("a session's subscription records no key (owner-wide, as today)", async () => {
    const id = await create("session");
    expect(await keyOf(id)).toBeNull();
  });
});

describe("GET /webhooks — a key sees only its own subscriptions", () => {
  it("each key lists its own; the session lists every one of the owner's", async () => {
    const mine = await create({ key: K1 });
    const theirs = await create({ key: K2 });
    const human = await create("session");
    expect(await list({ key: K1 })).toEqual([mine]);
    expect(await list({ key: K2 })).toEqual([theirs]);
    expect(await list("session")).toEqual([mine, theirs, human].sort());
  });
});

describe("GET /webhooks — a dead key's subscription shows inactive", () => {
  it("revoking (or expiring) the key turns its row inactive; the others stay active", async () => {
    const mine = await create({ key: K1 });
    const theirs = await create({ key: K2 });
    const human = await create("session");
    await q(`update api_keys set is_active = false where id = $1`, [K2]);
    try {
      const res = await app().request("/api/hub/webhooks", {
        headers: auth("session"),
      });
      const rows = (await res.json()) as Array<{ id: string; active: boolean }>;
      const active = Object.fromEntries(rows.map((r) => [r.id, r.active]));
      expect(active).toEqual({ [mine]: true, [theirs]: false, [human]: true });
      await q(
        `update api_keys set is_active = true, expires_at = now() - interval '1 minute' where id = $1`,
        [K2]
      );
      const again = (await (
        await app().request("/api/hub/webhooks", { headers: auth("session") })
      ).json()) as Array<{ id: string; active: boolean }>;
      expect(again.find((r) => r.id === theirs)?.active).toBe(false);
      // The app's tRPC listing (a session) says the same.
      const trpc = await webhooksRouter
        .createCaller({ authenticated: true, userId: OWNER } as never)
        .list();
      expect(Object.fromEntries(trpc.map((r) => [r.id, r.active]))).toEqual({
        [mine]: true,
        [theirs]: false,
        [human]: true,
      });
    } finally {
      await q(
        `update api_keys set is_active = true, expires_at = null where id = $1`,
        [K2]
      );
    }
  });
});

describe("DELETE /webhooks/:id — a key deletes only its own", () => {
  it("another key's and the session's rows are not found for a key", async () => {
    const theirs = await create({ key: K2 });
    const human = await create("session");
    expect((await remove({ key: K1 }, theirs)).status).toBe(404);
    expect((await remove({ key: K1 }, human)).status).toBe(404);
    expect(await list("session")).toEqual([theirs, human].sort());
  });

  it("a key deletes its own; a session deletes a key's", async () => {
    const mine = await create({ key: K1 });
    const theirs = await create({ key: K2 });
    expect((await remove({ key: K1 }, mine)).status).toBe(200);
    expect((await remove("session", theirs)).status).toBe(200);
    expect(await list("session")).toEqual([]);
  });
});
