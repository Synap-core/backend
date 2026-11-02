/**
 * The entity wire carries its lifecycle status (0319 columns `status`,
 * `status_category`), through the REAL `GET /entities` and `GET /entities/:id`
 * on PGlite (harness of `entities.last-interaction.pglite.test.ts`): a row with
 * the pair set serves it; a row with none serves null.
 *
 * Cannot see: Typesense documents (they carry no status); pod apps.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerEntitiesRoutes } from "./entities.js";
import type { HubHono, HubVariables } from "./_shared.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const A = randomUUID();
const WS = randomUUID();
const PROFILE = randomUUID();
const DEAL = randomUUID();
const WON = randomUUID();
const PLAIN = randomUUID();

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1, $2)`, [
    A,
    "a@example.test",
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
    [WS, "ws", A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, A]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'deal','Deal','kind','system','workspace',true,'{}'::jsonb,null)`,
    [PROFILE]
  );
  const rows: Array<[string, string, string | null, string | null]> = [
    [DEAL, "in-talks", "negotiation", "active"],
    [WON, "closed", "won", "done"],
    [PLAIN, "no-lifecycle", null, null],
  ];
  for (const [id, title, status, cat] of rows) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, status, status_category)
       values ($1,$2,$3,$4,'deal',$5,'{}'::jsonb,'{}'::jsonb,$6,$7)`,
      [id, A, WS, PROFILE, title, status, cat]
    );
  }
}, 120_000);

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", A);
    c.set("scopes", ["hub-protocol.read"]);
    c.set("apiKeyId", "key-a");
    await next();
  });
  registerEntitiesRoutes(a);
  return a;
}

type Row = {
  id: string;
  status?: string | null;
  statusCategory?: string | null;
};

describe("entity wire — lifecycle status", () => {
  it("GET /entities?profileSlug= carries status and statusCategory per row", async () => {
    const res = await app().request(
      `/entities?workspaceId=${WS}&profileSlug=deal&limit=10`
    );
    expect(res.status).toBe(200);
    const byId = new Map(((await res.json()) as Row[]).map((r) => [r.id, r]));
    expect(byId.get(DEAL)).toMatchObject({
      status: "negotiation",
      statusCategory: "active",
    });
    expect(byId.get(WON)).toMatchObject({
      status: "won",
      statusCategory: "done",
    });
    expect(byId.get(PLAIN)).toMatchObject({
      status: null,
      statusCategory: null,
    });
  });

  it("GET /entities/:id carries them too", async () => {
    const res = await app().request(`/entities/${DEAL}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: DEAL,
      status: "negotiation",
      statusCategory: "active",
    });
  });
});
