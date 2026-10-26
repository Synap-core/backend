/**
 * GET /entities — "who haven't I spoken to in a month" (CRM recall C-W2,
 * 0359), through the REAL route → hub `getEntities` → `entities.list`, run as
 * SQL on PGlite (the harness of `entities.sort.pglite.test.ts`):
 *
 *  - `sort=lastInteractionAt` orders the WHOLE set before paging, never last;
 *  - `lastInteractionBefore` keeps who we last spoke to before the bound, and
 *    `includeNever=true` adds the never-contacted;
 *  - an inverted or unparseable window, or one with `q`, is a 400;
 *  - each row carries `lastInteractionAt` (null = never) — the field the
 *    `scope=all` merge orders on, so the merge test reads it end to end.
 *
 * Cannot see: Typesense; the CRM app.
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
const WS2 = randomUUID();
const PERSON = randomUUID();
const day = (n: number) => new Date(Date.UTC(2026, 9, n));

// last_interaction_at: p2 (Oct 2) is the coldest, p20 the warmest; two never.
const ROWS = [
  { id: randomUUID(), title: "p20", at: day(20), ws: WS },
  { id: randomUUID(), title: "never-a", at: null, ws: WS },
  { id: randomUUID(), title: "p2", at: day(2), ws: WS2 },
  { id: randomUUID(), title: "p10", at: day(10), ws: WS },
  { id: randomUUID(), title: "never-b", at: null, ws: WS2 },
  { id: randomUUID(), title: "p5", at: day(5), ws: WS },
];
const titleOf = (id: string) => ROWS.find((r) => r.id === id)!.title;

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
  for (const ws of [WS, WS2]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${ws.slice(0, 4)}`, A]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, A]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'person','Person','kind','system','workspace',true,'{}'::jsonb,null)`,
    [PERSON]
  );
  for (const r of ROWS) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, last_interaction_at)
       values ($1,$2,$3,$4,'person',$5,'{}'::jsonb,'{}'::jsonb,$6)`,
      [r.id, A, r.ws, PERSON, r.title, r.at]
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

const url = (qs: string, ws = WS) =>
  `/entities?workspaceId=${ws}&profileSlug=person&${qs}`;
async function rows(
  qs: string,
  ws?: string
): Promise<Array<{ id: string; lastInteractionAt?: string | null }>> {
  const res = await app().request(url(qs, ws));
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{
    id: string;
    lastInteractionAt?: string | null;
  }>;
}
const titles = async (qs: string, ws?: string) =>
  (await rows(qs, ws)).map((r) => titleOf(r.id));

describe("GET /entities — lastInteractionAt", () => {
  it("sorts the whole set before paging, coldest first, never last", async () => {
    const p1 = await titles("sort=lastInteractionAt:asc&limit=2&offset=0");
    const p2 = await titles("sort=lastInteractionAt:asc&limit=2&offset=2");
    expect([...p1, ...p2]).toEqual(["p5", "p10", "p20", "never-a"]);
  });

  it("each row carries the value; never is null", async () => {
    const byTitle = new Map(
      (await rows("limit=10")).map((r) => [titleOf(r.id), r.lastInteractionAt])
    );
    expect(new Date(String(byTitle.get("p10"))).toISOString()).toBe(
      day(10).toISOString()
    );
    expect(byTitle.get("never-a")).toBeNull();
  });

  it("lastInteractionBefore keeps who went cold; includeNever adds the never-contacted", async () => {
    const before = `lastInteractionBefore=${day(15).toISOString()}`;
    expect(await titles(`${before}&sort=lastInteractionAt:asc`)).toEqual([
      "p5",
      "p10",
    ]);
    expect(
      await titles(`${before}&includeNever=true&sort=lastInteractionAt:asc`)
    ).toEqual(["p5", "p10", "never-a"]);
  });

  it("lastInteractionAfter is inclusive", async () => {
    expect(
      await titles(
        `lastInteractionAfter=${day(10).toISOString()}&sort=lastInteractionAt:desc`
      )
    ).toEqual(["p20", "p10"]);
  });

  it("scope=all orders the merge on the wire value", async () => {
    const res = await app().request(
      `/entities?scope=all&profileSlug=person&sort=lastInteractionAt:asc&limit=10`
    );
    expect(res.status).toBe(200);
    const got = ((await res.json()) as Array<{ id: string }>).map((r) =>
      titleOf(r.id)
    );
    expect(got.slice(0, 4)).toEqual(["p2", "p5", "p10", "p20"]);
    expect(new Set(got.slice(4))).toEqual(new Set(["never-a", "never-b"]));
  });

  it.each([
    [
      "an inverted window",
      `lastInteractionAfter=${day(20).toISOString()}&lastInteractionBefore=${day(1).toISOString()}`,
    ],
    ["an unparseable bound", "lastInteractionBefore=last-month"],
    ["a window with q", `q=p&lastInteractionBefore=${day(15).toISOString()}`],
  ])("%s is a 400", async (_n, qs) => {
    const res = await app().request(url(qs));
    expect(res.status).toBe(400);
  });
});
