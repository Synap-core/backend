/**
 * GET /messaging/accounts — the connection-status door an app reads (founder
 * decision 3, 2026-10-26): which accounts the person connected, never a
 * credential. A key holding `messaging.read` reaches it (grant-door-fence.ts
 * `PERSON("messaging")`); this pins what it answers.
 *
 *  - the EXACT key set of a row, so a field added to the stored row or to a
 *    connector's live account (a token, a cookie) never rides out to an app.
 *    The live account below carries an `accessToken`: a door that spread the
 *    live object instead of projecting it would return it;
 *  - the live status wins over the stored one, and a disconnected account is
 *    not listed;
 *  - a failed live read is an error (503), never the stored rows: those carry
 *    the LAST known status, so a dead read used to answer "connected".
 *
 * Through the REAL route on PGlite; the connector is a stub.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  live: [] as Array<Record<string, unknown>> | Error,
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
vi.mock("../../../connectors/index.js", () => ({
  getMessagingConnector: async () => ({
    getAccounts: async () => {
      if (h.live instanceof Error) throw h.live;
      return h.live;
    },
  }),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { registerMessagingRoutes } from "./messaging.js";
import type { HubHono, HubVariables } from "./_shared.js";

const ALICE = "alice-ar";
const BOB = "bob-ar";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

function read(userId = ALICE) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerMessagingRoutes(app);
  return app.request("/messaging/accounts");
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  const row = `insert into messaging_accounts (id, user_id, workspace_id, provider, external_id, display_name, status) values ($1, $2, $3, $4, $5, $6, $7)`;
  await q(row, [
    "acc-li",
    ALICE,
    "ws-1",
    "linkedin",
    "ext-li",
    "Alice L",
    "connected",
  ]);
  await q(row, [
    "acc-gm",
    ALICE,
    null,
    "gmail",
    "ext-gm",
    "alice@x",
    "connected",
  ]);
  await q(row, [
    "acc-wa",
    ALICE,
    null,
    "whatsapp",
    "ext-wa",
    "Alice W",
    "disconnected",
  ]);
  await q(row, [
    "acc-bob",
    BOB,
    null,
    "linkedin",
    "ext-bob",
    "Bob",
    "connected",
  ]);
});

beforeEach(() => {
  h.live = [
    {
      id: "live-li",
      externalId: "ext-li",
      provider: "linkedin",
      displayName: "Alice Liddell",
      status: "connected",
      accessToken: "secret-token",
    },
    {
      id: "live-gm",
      externalId: "ext-gm",
      provider: "gmail",
      displayName: "alice@x",
      status: "reconnection_required",
      accessToken: "secret-token",
    },
  ];
});

describe("GET /messaging/accounts — what an app learns about connected accounts", () => {
  it("each row is exactly {id, externalId, provider, displayName, status}: no credential, no extra field", async () => {
    const res = await read();
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows)
      expect(Object.keys(r).sort()).toEqual([
        "displayName",
        "externalId",
        "id",
        "provider",
        "status",
      ]);
    expect(JSON.stringify(rows)).not.toContain("secret-token");
  });

  it("the live status and name win; a disconnected account and another person's are not listed", async () => {
    const rows = (await (await read()).json()) as Array<
      Record<string, unknown>
    >;
    expect(
      rows.map((r) => [r.provider, r.displayName, r.status]).sort()
    ).toEqual([
      ["gmail", "alice@x", "reconnection_required"],
      ["linkedin", "Alice Liddell", "connected"],
    ]);
  });

  it("a failed live read is a 503, never the stored 'connected'", async () => {
    h.live = new Error("unipile unreachable");
    const res = await read();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toMatch(/could not read/i);
    expect(Array.isArray(body)).toBe(false);
  });
});
