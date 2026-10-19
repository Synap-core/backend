/**
 * A catalog template's `profiles[].lifecycle` reaches a DECLARED lifecycle
 * through the REAL `reconcileWorkspaceFromDefinition` (work model L1), on
 * PGlite, driven by the REAL catalog profiles (the generated `templates.ts`).
 *
 * Pinned:
 *  - a fresh apply declares the lifecycle (`getEffectiveLifecycle` reads the
 *    catalog's categories back);
 *  - a RE-APPLY onto a profile that already exists — every live pod, once the
 *    catalog gains a declaration — declares it too. This was the dropped hop:
 *    the declaration ran only for a profile the same pass had created
 *    (`!profileIsReused`), and every existing profile resolves as reused;
 *  - a system kind the template extends (`deal`) gets the template's
 *    lifecycle on first apply;
 *  - a reused profile that already declares a lifecycle KEEPS it.
 *
 * Schema: derived from the drizzle tables, plus the 0319 one-lifecycle index.
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
import { ProfileResolutionService } from "../services/profile-resolution-service.js";
import { buildStoredConstraints } from "./property-enum.js";

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

type CatalogProfile = {
  slug: string;
  lifecycle?: {
    property: string;
    options: Array<{ key: string; category: string; humanOnly?: boolean }>;
  };
  [k: string]: unknown;
};
let catalog: Record<string, { profiles: CatalogProfile[] }>;
const profileOf = (template: string, slug: string) =>
  catalog[template].profiles.find((p) => p.slug === slug)!;

const USER = "user-l1c";
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
     values ($1, 'CRM', $2, '{}'::jsonb, now(), now())`,
    [WS, USER]
  );
});

const reconcile = (profiles: CatalogProfile[]) =>
  reconcileWorkspaceFromDefinition({
    workspaceId: WS,
    userId: USER,
    definition: { profiles } as never,
  });

async function lifecycleOf(slug: string) {
  const [p] = await q<{ id: string }>(
    `select id from profiles where slug = $1 and is_active`,
    [slug]
  );
  return new ProfileResolutionService(h.db as never).getEffectiveLifecycle(
    p.id
  );
}

const categoriesOf = (
  lc: { options: Array<{ key: string; category: string }> } | null
) => Object.fromEntries((lc?.options ?? []).map((o) => [o.key, o.category]));

describe("reconcile declares the catalog lifecycle", () => {
  it("non-vacuity: the real catalog declares the profiles this suite drives", () => {
    expect(profileOf("foundation", "lead").lifecycle?.property).toBe(
      "leadStage"
    );
    expect(profileOf("foundation", "client").lifecycle?.property).toBe(
      "clientStatus"
    );
    expect(profileOf("crm", "deal").lifecycle?.property).toBe(
      "commercialStage"
    );
  });

  it("a fresh apply declares it, with the catalog's categories", async () => {
    const lead = profileOf("foundation", "lead");
    const report = await reconcile([lead]);
    expect(report.properties.lifecycles?.declared).toEqual([
      { profile: "lead", property: "leadStage" },
    ]);
    const lc = await lifecycleOf("lead");
    expect(lc?.propertySlug).toBe("leadStage");
    expect(categoriesOf(lc)).toEqual(
      Object.fromEntries(
        lead.lifecycle!.options.map((o) => [o.key, o.category])
      )
    );
  });

  it("a RE-APPLY onto an existing profile declares it (every live pod)", async () => {
    const client = profileOf("foundation", "client");
    const { lifecycle: _lc, ...before } = client;
    // The pod installed the template before it declared a lifecycle.
    await reconcile([before as CatalogProfile]);
    expect(await lifecycleOf("client")).toBeNull();

    const report = await reconcile([client]);
    expect(report.profiles.reused).toContain("client");
    expect(report.properties.lifecycles?.declared).toEqual([
      { profile: "client", property: "clientStatus" },
    ]);
    const lc = await lifecycleOf("client");
    expect(lc?.propertySlug).toBe("clientStatus");
    expect(categoriesOf(lc).churned).toBe("lost");
    expect(lc?.unclassified).toEqual([]);
  });

  it("a system kind the template extends (deal) gets the template's lifecycle", async () => {
    await q(
      `insert into profiles (id, slug, display_name, scope, workspace_id, user_id, is_active, profile_kind)
       values (gen_random_uuid(), 'deal', 'Deal', 'system', null, 'system', true, 'kind')`
    );
    const report = await reconcile([profileOf("crm", "deal")]);
    expect(report.profiles.reused).toContain("deal");
    const lc = await lifecycleOf("deal");
    expect(lc?.propertySlug).toBe("commercialStage");
    expect(lc?.options.find((o) => o.key === "lost")).toMatchObject({
      category: "lost",
      humanOnly: true,
    });
  });

  it("a reused profile that already declares a lifecycle keeps it", async () => {
    const [task] = await q<{ id: string }>(
      `insert into profiles (id, slug, display_name, scope, workspace_id, user_id, is_active, profile_kind)
       values (gen_random_uuid(), 'task', 'Task', 'system', null, 'system', true, 'kind') returning id`
    );
    const [def] = await q<{ id: string }>(
      `insert into property_defs (id, slug, value_type, profile_id, constraints)
       values (gen_random_uuid(), 'status', 'string', $1, $2::jsonb) returning id`,
      [
        task.id,
        JSON.stringify(
          buildStoredConstraints({
            enumOptions: [
              { key: "todo", category: "open" },
              { key: "done", category: "done" },
            ],
          })
        ),
      ]
    );
    await q(
      `insert into profile_properties (profile_id, property_def_id, is_lifecycle) values ($1, $2, true)`,
      [task.id, def.id]
    );

    const report = await reconcile([
      {
        slug: "task",
        displayName: "Task",
        properties: [
          {
            slug: "task-status",
            label: "Status",
            valueType: "string",
            inputType: "select",
            enumValues: ["Backlog", "Done"],
          },
        ],
        lifecycle: {
          property: "task-status",
          options: [
            { key: "Backlog", category: "open" },
            { key: "Done", category: "done" },
          ],
        },
      },
    ]);
    expect(report.properties.lifecycles?.declared).toEqual([]);
    expect(report.properties.lifecycles?.refused).toEqual([]);
    expect((await lifecycleOf("task"))?.propertySlug).toBe("status");
  });
});
