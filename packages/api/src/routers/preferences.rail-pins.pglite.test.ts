/**
 * RAIL PINS (surfaces W1.7) on PGlite through the REAL `preferences.*` doors:
 *  - a space's template `sidebarItems` pipeline views are SUGGESTED pins
 *    (by viewId, or by a name only one pipeline view in the space has);
 *  - pin / unpin / reorder persist the effective list and seed every space in
 *    view, so an unpinned suggestion never comes back — while a space that
 *    appears later still suggests its own;
 *  - a pin must name a real, readable surface of that kind; pinning twice
 *    keeps one pin; another person's pins are untouched.
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
import { preferencesRouter } from "./preferences.js";

const U = randomUUID();
const OTHER = randomUUID();
const W1 = randomUUID();
const W2 = randomUUID();
const W3 = randomUUID();

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
        : c.name === "ui_preferences"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function space(id: string, owner: string, sidebarItems: unknown[]) {
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,$3::jsonb)`,
    [id, owner, JSON.stringify({ layout: { sidebarItems } })]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), id, owner]
  );
}
async function view(
  ws: string,
  name: string,
  type: string,
  config: unknown
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into views (id, workspace_id, user_id, name, type, scope_profile_ids, query, config, metadata)
     values ($1,$2,$3,$4,$5,'{}'::uuid[],'{}'::jsonb,$6::jsonb,'{}'::jsonb)`,
    [id, ws, U, name, type, JSON.stringify(config)]
  );
  return id;
}

const as = (userId: string) =>
  preferencesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);
const keys = async (userId = U) =>
  (await as(userId).railPins()).pins.map((p) => p.key);

let LEADS = "";
let POSTS = "";
let TABLE = "";
let LATER = "";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  for (const u of [U, OTHER])
    await q(`insert into users (id, email) values ($1,$2)`, [u, `${u}@x.io`]);
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values
      (gen_random_uuid(),'lead','Lead','role','workspace'),
      (gen_random_uuid(),'post','Post','kind','workspace'),
      (gen_random_uuid(),'client','Client','role','workspace')`
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [W1, U]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W1, U]
  );
  LEADS = await view(W1, "Lead Pipeline", "pipeline", { profileSlug: "lead" });
  TABLE = await view(W1, "Leads table", "table", { profileSlug: "lead" });
  POSTS = randomUUID();
  // W1's sidebar: the pipeline BY NAME, a table view, an app. Only the
  // pipeline is a pin.
  await q(`update workspaces set settings = $2::jsonb where id = $1`, [
    W1,
    JSON.stringify({
      layout: {
        sidebarItems: [
          { kind: "app", appId: "chat" },
          { kind: "view", viewName: "Lead Pipeline", label: "Leads" },
          { kind: "view", viewId: TABLE },
        ],
      },
    }),
  ]);
  await space(W2, U, []);
  POSTS = await view(W2, "Posts", "pipeline", { profileSlug: "post" });
  await q(`update workspaces set settings = $2::jsonb where id = $1`, [
    W2,
    JSON.stringify({
      layout: { sidebarItems: [{ kind: "view", viewId: POSTS }] },
    }),
  ]);
  // Another person's space — never suggested to U.
  await space(randomUUID(), OTHER, []);
});

describe("preferences rail pins", () => {
  it("suggests the pipeline views each visible space's sidebar names", async () => {
    const { pins } = await as(U).railPins();
    expect(pins).toEqual(
      expect.arrayContaining([
        {
          key: `view:${LEADS}`,
          profileSlug: "lead",
          viewId: LEADS,
          label: "Leads",
          source: "template",
        },
        {
          key: `view:${POSTS}`,
          profileSlug: "post",
          viewId: POSTS,
          label: "Posts",
          source: "template",
        },
      ])
    );
    expect(pins).toHaveLength(2);
    expect(await keys(OTHER)).toEqual([]);
  });

  it("pin appends (idempotent), unpin removes for good, a later space still suggests", async () => {
    await as(U).pinSurface({ profileSlug: "client" });
    await as(U).pinSurface({ profileSlug: "client" });
    expect((await keys()).filter((k) => k === "kind:client")).toHaveLength(1);

    await as(U).unpinSurface({ key: `view:${LEADS}` });
    expect(await keys()).not.toContain(`view:${LEADS}`);
    // A re-read does not resurrect it: W1 is seeded now.
    expect(await keys()).not.toContain(`view:${LEADS}`);

    await space(W3, U, []);
    LATER = await view(W3, "Later", "pipeline", { profileSlug: "post" });
    await q(`update workspaces set settings = $2::jsonb where id = $1`, [
      W3,
      JSON.stringify({
        layout: { sidebarItems: [{ kind: "view", viewId: LATER }] },
      }),
    ]);
    expect(await keys()).toContain(`view:${LATER}`);
  });

  it("reorder puts the named keys first and keeps the rest", async () => {
    const before = await keys();
    await as(U).reorderRailPins({ keys: ["kind:client", "nope"] });
    const after = await keys();
    expect(after[0]).toBe("kind:client");
    expect(new Set(after)).toEqual(new Set(before));
  });

  it("a pin must name a real, readable surface of that kind", async () => {
    await expect(
      as(U).pinSurface({ profileSlug: "nope" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      as(U).pinSurface({ profileSlug: "post", viewId: LEADS })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as(U).pinSurface({ profileSlug: "lead", viewId: TABLE })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // OTHER cannot pin U's view.
    await expect(
      as(OTHER).pinSurface({ profileSlug: "lead", viewId: LEADS })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
