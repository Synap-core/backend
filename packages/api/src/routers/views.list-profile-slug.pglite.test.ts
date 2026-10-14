/**
 * `views.list({ type, profileSlug })` (surfaces W1.6) — find a kind's saved
 * pipeline views (intent surfaces) in a lens, on PGlite through the REAL
 * router and its real access floor. A WHERE clause before the page limit,
 * never a page filter.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

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
import { viewsRouter } from "./views.js";

const A = randomUUID();
const WA = randomUUID();
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
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function view(type: string, config: unknown): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into views (id, workspace_id, user_id, name, type, scope_profile_ids, query, config, metadata)
     values ($1, $2, $3, 'v', $4, '{}'::uuid[], '{}'::jsonb, $5::jsonb, '{}'::jsonb)`,
    [id, WA, A, type, JSON.stringify(config)]
  );
  return id;
}

let LEADS = "";
let LEADS_PROJECT = "";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, $2)`, [A, "a@x.io"]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [WA, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WA, A]
  );
  LEADS = await view("pipeline", {
    profileSlug: "lead",
    surface: { tab: "pipeline" },
  });
  LEADS_PROJECT = await view("pipeline", {
    profileSlug: "lead",
    projectId: randomUUID(),
  });
  await view("pipeline", { profileSlug: "post" });
  await view("table", { profileSlug: "lead" });
});

const list = (input: Record<string, unknown>) =>
  viewsRouter
    .createCaller({
      authenticated: true,
      userId: A,
      workspaceId: null,
    } as never)
    .list({ workspaceId: WA, limit: 50, ...input } as never)
    .then(
      (r) =>
        new Set((r as { items: Array<{ id: string }> }).items.map((v) => v.id))
    );

describe("views.list — profileSlug", () => {
  it("type + profileSlug finds the kind's saved pipeline views in the lens", async () => {
    expect(await list({ type: "pipeline", profileSlug: "lead" })).toEqual(
      new Set([LEADS, LEADS_PROJECT])
    );
    // Non-vacuity: without the slug every pipeline lists.
    expect((await list({ type: "pipeline" })).size).toBe(3);
    // Without the type, any view naming the slug.
    expect((await list({ profileSlug: "lead" })).size).toBe(3);
  });
});
