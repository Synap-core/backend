/**
 * A template's property declaration must NEVER write a pod-wide GLOBAL
 * property def (profile_id + workspace_id NULL), on PGlite, through the REAL
 * `reconcileWorkspaceFromDefinition`.
 *
 * The incident (live pod, 2026-10-12 16:27 UTC): CRM's `lead` role declared
 * `source` with the lead-source enum. `getBySlug(slug, profileId, null)` misses
 * the profile-scoped def and FALLS BACK to the global `source` def; the enum
 * sync then UNIONED CRM's list into it. Every kind linking `source` (bookmark
 * and its children…) was narrowed, and connectors writing
 * `source: 'fal.ai'` were refused at approval — after the provider billed.
 *
 * Pinned:
 *  - an unlinked global with the slug is untouched, and the profile gets its
 *    OWN def carrying the template's enum (what the create door does);
 *  - a global the profile already links is untouched, reported in
 *    `globalsKept`, and no same-slug twin is added beside it;
 *  - control: the profile's own def still converges to the template enum.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("../schema/index.js");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("../client-pg.js", async () => {
  const db = await h.init();
  return { db, sql: undefined, getDb: async () => db };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { reconcileWorkspaceFromDefinition } from "./reconcile-workspace-from-definition.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = async <T = any>(sql: string, params?: unknown[]) =>
  (await h.client!.query<T>(sql, params)).rows;

const USER = "user-global-def";
let WS: string;
let GLOBAL_ID: string;

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one this door reads.
      }
    }
  }
  await h.client!.exec(`
    create unique index if not exists profile_properties_pk
      on profile_properties (profile_id, property_def_id);
    create unique index if not exists profile_workspace_access_pk
      on profile_workspace_access (profile_id, workspace_id);
  `);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from profile_properties; delete from property_defs; delete from profile_workspace_access; delete from profiles; delete from workspaces;`
  );
  WS = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'CRM', $2, '{}'::jsonb, now(), now())`,
    [WS, USER]
  );
  [{ id: GLOBAL_ID }] = await q<{ id: string }>(
    `insert into property_defs (id, slug, value_type, profile_id, workspace_id, constraints, ui_hints)
     values (gen_random_uuid(), 'source', 'string', null, null, '{}'::jsonb,
             '{"label":"Source","inputType":"text"}'::jsonb) returning id`
  );
});

const LEAD_ENUM = ["cold-outreach", "referral", "other"];
const sourceProp = (enumValues: string[]) => ({
  slug: "source",
  label: "Source",
  valueType: "string",
  inputType: "select",
  enumValues,
});

const reconcile = (profiles: unknown[]) =>
  reconcileWorkspaceFromDefinition({
    workspaceId: WS,
    userId: USER,
    definition: { profiles } as never,
  });

async function globalDef() {
  const [row] = await q<{ constraints: Record<string, unknown> }>(
    `select constraints from property_defs where id = $1`,
    [GLOBAL_ID]
  );
  return row;
}

async function sourceDefsOf(profileSlug: string) {
  return q<{ id: string; constraints: { enum?: string[] } }>(
    `select pd.id, pd.constraints from property_defs pd
       join profile_properties pp on pp.property_def_id = pd.id
       join profiles p on p.id = pp.profile_id
      where p.slug = $1 and pd.slug = 'source'`,
    [profileSlug]
  );
}

describe("reconcile never writes a pod-wide global property def", () => {
  it("an unlinked global keeps its shape; the profile gets its OWN def", async () => {
    const report = await reconcile([
      {
        slug: "lead",
        displayName: "Lead",
        scope: "shared",
        profileKind: "role",
        properties: [sourceProp(LEAD_ENUM)],
      },
    ]);
    expect((await globalDef()).constraints).toEqual({});
    expect(report.properties.enumsUpdated).toEqual([]);
    expect(report.properties.added).toEqual([
      { profile: "lead", slug: "source" },
    ]);
    const own = await sourceDefsOf("lead");
    expect(own).toHaveLength(1);
    expect(own[0]!.id).not.toBe(GLOBAL_ID);
    expect(own[0]!.constraints.enum).toEqual(LEAD_ENUM);
  });

  it("a global the profile already links is kept, never narrowed or twinned", async () => {
    await reconcile([
      { slug: "bookmark", displayName: "Bookmark", properties: [] },
    ]);
    const [bookmark] = await q<{ id: string }>(
      `select id from profiles where slug = 'bookmark'`
    );
    await q(
      `insert into profile_properties (profile_id, property_def_id) values ($1, $2)`,
      [bookmark!.id, GLOBAL_ID]
    );

    const report = await reconcile([
      {
        slug: "bookmark",
        displayName: "Bookmark",
        properties: [sourceProp(LEAD_ENUM)],
      },
    ]);
    expect((await globalDef()).constraints).toEqual({});
    expect(report.properties.globalsKept).toEqual([
      { profile: "bookmark", slug: "source" },
    ]);
    expect(report.properties.enumsUpdated).toEqual([]);
    expect((await sourceDefsOf("bookmark")).map((d) => d.id)).toEqual([
      GLOBAL_ID,
    ]);
  });

  it("control: the profile's OWN def still converges to the template enum", async () => {
    await reconcile([
      {
        slug: "lead",
        displayName: "Lead",
        scope: "shared",
        profileKind: "role",
        properties: [sourceProp(["referral"])],
      },
    ]);
    const report = await reconcile([
      {
        slug: "lead",
        displayName: "Lead",
        scope: "shared",
        profileKind: "role",
        properties: [sourceProp(LEAD_ENUM)],
      },
    ]);
    expect(report.properties.enumsUpdated).toEqual([
      { profile: "lead", slug: "source" },
    ]);
    expect((await sourceDefsOf("lead"))[0]!.constraints.enum).toEqual(
      LEAD_ENUM
    );
    expect((await globalDef()).constraints).toEqual({});
  });
});
