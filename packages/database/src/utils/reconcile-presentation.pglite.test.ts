/**
 * A catalog profile's `presentation` (entity rendering, decision 8) reaches
 * `profiles.ui_hints.presentation` through the REAL
 * `reconcileWorkspaceFromDefinition`, on PGlite, driven by the REAL catalog
 * profiles (the generated `templates.ts`).
 *
 * Pinned:
 *  - a RE-APPLY onto a profile installed BEFORE the catalog declared a
 *    presentation (every live pod) gains it — `ui_hints` is otherwise
 *    create-only — and keeps icon/color/description;
 *  - any other ui_hints key survives the merge; a stale presentation is replaced;
 *  - a second apply writes nothing (`report.profiles.presentations` absent);
 *  - a profile that declares none is left alone.
 *
 * Harness: same derived-schema PGlite as `reconcile-lifecycle.pglite.test.ts`.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = async <T = any>(sql: string, params?: unknown[]) =>
  (await h.client!.query<T>(sql, params)).rows;

type CatalogProfile = {
  slug: string;
  presentation?: Record<string, unknown>;
  [k: string]: unknown;
};
let catalog: Record<string, { profiles: CatalogProfile[] }>;
const profileOf = (template: string, slug: string) =>
  catalog[template].profiles.find((p) => p.slug === slug)!;

const USER = "user-presentation";
let WS: string;

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
  // The composite keys the doors' ON CONFLICT targets name, and 0319's
  // one-lifecycle index.
  await h.client!.exec(`
    create unique index if not exists profile_properties_pk
      on profile_properties (profile_id, property_def_id);
    create unique index if not exists profile_workspace_access_pk
      on profile_workspace_access (profile_id, workspace_id);
    create unique index if not exists profile_properties_one_lifecycle_uniq
      on profile_properties (profile_id) where is_lifecycle;
  `);
  ({ WORKSPACE_TEMPLATES: catalog } =
    (await import("../../../../../synap-app/packages/workspace-templates/src/templates.js")) as unknown as {
      WORKSPACE_TEMPLATES: typeof catalog;
    });
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from profile_properties; delete from property_defs; delete from profile_workspace_access; delete from profiles; delete from workspaces;`
  );
  WS = randomUUID();
  await q(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Brand', $2, '{}'::jsonb, now(), now())`,
    [WS, USER]
  );
});

const reconcile = (profiles: CatalogProfile[]) =>
  reconcileWorkspaceFromDefinition({
    workspaceId: WS,
    userId: USER,
    definition: { profiles } as never,
  });

const hintsOf = async (slug: string) =>
  (
    await q<{ ui_hints: Record<string, unknown> }>(
      `select ui_hints from profiles where slug = $1`,
      [slug]
    )
  )[0]?.ui_hints;

describe("reconcile converges the catalog presentation", () => {
  it("non-vacuity: the real catalog declares the profile this suite drives", () => {
    expect(profileOf("brand-library", "brand-asset").presentation).toEqual({
      family: "media",
      media: { source: { property: "asset-document-id" } },
    });
  });

  it("a RE-APPLY onto an existing profile gains it, keeping icon/color/description", async () => {
    const asset = profileOf("brand-library", "brand-asset");
    const { presentation, ...before } = asset;
    // The pod installed the template before it declared a presentation.
    await reconcile([before as CatalogProfile]);
    const born = await hintsOf("brand-asset");
    expect(born.presentation).toBeUndefined();
    expect(born.icon).toBe(asset.icon);

    const report = await reconcile([asset]);
    expect(report.profiles.reused).toContain("brand-asset");
    expect(report.profiles.presentations).toEqual(["brand-asset"]);
    const hints = await hintsOf("brand-asset");
    expect(hints.presentation).toEqual(presentation);
    expect(hints.icon).toBe(asset.icon);
    expect(hints.color).toBe(asset.color);
    expect(hints.description).toBe(asset.description);

    // Converged: a second apply writes nothing.
    const again = await reconcile([asset]);
    expect(again.profiles.presentations).toBeUndefined();
  });

  it("other ui_hints keys survive, and a stale presentation is replaced", async () => {
    const asset = profileOf("brand-library", "brand-asset");
    const { presentation: _p, ...before } = asset;
    await reconcile([before as CatalogProfile]);
    await q(
      `update profiles set ui_hints = ui_hints || '{"hideFromCreate": true, "presentation": {"family": "record"}}'::jsonb where slug = 'brand-asset'`
    );
    const report = await reconcile([asset]);
    expect(report.profiles.presentations).toEqual(["brand-asset"]);
    const hints = await hintsOf("brand-asset");
    expect(hints.hideFromCreate).toBe(true);
    expect(hints.presentation).toEqual(asset.presentation);
  });

  it("a profile that declares no presentation is left alone", async () => {
    const asset = profileOf("brand-library", "brand-asset");
    const { presentation: _p, ...before } = asset;
    await reconcile([before as CatalogProfile]);
    await q(
      `update profiles set ui_hints = ui_hints || '{"presentation": {"family": "record"}}'::jsonb where slug = 'brand-asset'`
    );
    const report = await reconcile([before as CatalogProfile]);
    expect(report.profiles.presentations).toBeUndefined();
    expect((await hintsOf("brand-asset")).presentation).toEqual({
      family: "record",
    });
  });
});
