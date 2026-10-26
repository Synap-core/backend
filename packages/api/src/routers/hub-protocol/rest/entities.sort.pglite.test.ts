/**
 * GET /entities `sort` — driven through the REAL route, the REAL
 * `getCaller` → hub `entities.getEntities` → `entities.list`, compiled and run
 * as SQL on PGlite (same harness as `entities.user-floor.pglite.test.ts`).
 *
 * Defects this pins (plan C-W1, readiness wave 2026-10-26):
 *
 *  - the order is applied in SQL BEFORE paging: page 2 continues page 1 in
 *    `updatedAt` order. It used to reorder only the rows of the page that the
 *    `createdAt` order had already cut, so the set was never sorted.
 *  - an unknown sort field or direction is a 400, not a silent default.
 *  - `sort` with `q` is a 400 (the `q` branch is relevance-ranked).
 *
 * Created order is the REVERSE of updated order on purpose: with a page sort
 * restored, page 1 would hold the two newest-CREATED rows, not the two
 * newest-UPDATED ones.
 *
 * Cannot see: production Postgres collation for `title`, Typesense.
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
const NOTE = randomUUID();

// i = 0..5. created_at rises with i; updated_at FALLS with i, so the newest
// updated row is e0 and the newest created row is e5. Titles are scrambled.
const TITLES = ["delta", "Bravo", "echo", "alpha", null, "Charlie"];
const ROWS = TITLES.map((title, i) => ({ id: randomUUID(), title, i }));
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

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
    `insert into workspaces (id, name, owner_id, settings) values ($1,'ws',$2,'{}'::jsonb)`,
    [WS, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, A]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'note','Note','kind','system','workspace',true,'{}'::jsonb,null)`,
    [NOTE]
  );
  for (const r of ROWS) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, created_at, updated_at)
       values ($1,$2,$3,$4,'note',$5,'{}'::jsonb,'{}'::jsonb,$6,$7)`,
      [r.id, A, WS, NOTE, r.title, day(r.i), day(100 - r.i)]
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

const url = (qs: string) =>
  `/entities?workspaceId=${WS}&profileSlug=note&${qs}`;
async function page(qs: string): Promise<string[]> {
  const res = await app().request(url(qs));
  expect(res.status).toBe(200);
  return ((await res.json()) as Array<{ id: string }>).map((r) => r.id);
}
const byUpdatedDesc = ROWS.map((r) => r.id); // e0 is newest-updated

describe("GET /entities?sort — applied before paging", () => {
  it("page 2 continues page 1 in updatedAt order", async () => {
    const p1 = await page("sort=updatedAt:desc&limit=2&offset=0");
    const p2 = await page("sort=updatedAt:desc&limit=2&offset=2");
    const p3 = await page("sort=updatedAt:desc&limit=2&offset=4");
    expect([...p1, ...p2, ...p3]).toEqual(byUpdatedDesc);
  });

  it("ascending flips the whole set, not a page", async () => {
    expect(await page("sort=updatedAt:asc&limit=2")).toEqual(
      [...byUpdatedDesc].reverse().slice(0, 2)
    );
  });

  it("the default order is still newest created first", async () => {
    expect(await page("limit=2")).toEqual(
      [...ROWS]
        .reverse()
        .slice(0, 2)
        .map((r) => r.id)
    );
  });

  it("title sorts case-insensitively, nulls last", async () => {
    const ids = await page("sort=title:asc&limit=10");
    const titles = ids.map((id) => ROWS.find((r) => r.id === id)!.title);
    expect(titles).toEqual([
      "alpha",
      "Bravo",
      "Charlie",
      "delta",
      "echo",
      null,
    ]);
  });

  it("scope=all orders the merge, and pages it", async () => {
    const p1 = await page("scope=all&sort=updatedAt:desc&limit=3&offset=0");
    const p2 = await page("scope=all&sort=updatedAt:desc&limit=3&offset=3");
    expect([...p1, ...p2]).toEqual(byUpdatedDesc);
  });
});

describe("GET /entities?sort — unsupported values are a 400", () => {
  it.each([
    ["an unknown field", "sort=lastInteractionAt:desc"],
    ["a bare unknown field", "sort=bogus"],
    ["an unknown direction", "sort=updatedAt:sideways"],
    ["an extra segment", "sort=updatedAt:desc:x"],
  ])("%s", async (_n, qs) => {
    const res = await app().request(url(qs));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /Unsupported sort/
    );
  });

  it("sort cannot ride with q", async () => {
    const res = await app().request(url("q=alpha&sort=updatedAt:desc"));
    expect(res.status).toBe(400);
  });
});
