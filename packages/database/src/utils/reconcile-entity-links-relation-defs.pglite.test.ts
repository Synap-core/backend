/**
 * Template reconcile, step 4 (`entityLinks`) — on a real Postgres (PGlite),
 * through the REAL `reconcileWorkspaceFromDefinition` and the REAL
 * `RelationDefRepository`.
 *
 * Pins (schema convergence D5):
 *   - an entityLink naming a slug that already resolves pod-wide REUSES that
 *     row: no workspace copy is minted, the edge sits on the pod-wide def, and
 *     a re-run neither mints one nor touches the curated description/uiHints;
 *   - a slug nothing resolves gets ONE workspace def, carrying the template's
 *     own `relationDefs` metadata (never bare), stable across re-runs;
 *   - `RelationDefRepository.create`'s find-or-update branch writes only the
 *     fields the caller supplied — an omitted description/uiHints/
 *     isDirectional is never wiped.
 *
 * Schema: derived from the drizzle tables; the two partial unique indexes and
 * the profile_relations primary key the doors depend on are created explicitly,
 * mirroring 0000_baseline_schema.sql / 0118.
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
import { RelationDefRepository } from "../repositories/relation-def-repository.js";

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

const USER = "user-d5";
const WS = randomUUID();

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
    create unique index if not exists relation_defs_slug_pod_unique
      on relation_defs (slug) where workspace_id is null;
    create unique index if not exists relation_defs_slug_workspace_unique
      on relation_defs (slug, workspace_id) where workspace_id is not null;
    create unique index if not exists profile_relations_pk
      on profile_relations (source_profile_id, target_profile_id, relation_def_id);
  `);
}, 120_000);

let task: string;
let project: string;

beforeEach(async () => {
  await h.client!.exec(
    `delete from profile_relations; delete from relation_defs; delete from profiles; delete from workspaces;`
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Builder', $2, '{}'::jsonb, now(), now())`,
    [WS, USER]
  );
  const mk = async (slug: string) =>
    (
      await q<{ id: string }>(
        `insert into profiles (id, slug, display_name, scope, workspace_id, user_id, is_active)
         values (gen_random_uuid(), $1, $1, 'system', null, $2, true) returning id`,
        [slug, USER]
      )
    )[0].id;
  task = await mk("task");
  project = await mk("project");
});

const GLOBAL_DEPENDS = {
  displayName: "Depends On",
  description: "This item depends on the target",
  uiHints: { icon: "link", inverseLabel: "Blocks" },
};

async function seedGlobalDependsOn(): Promise<string> {
  return (
    await q<{ id: string }>(
      `insert into relation_defs (id, slug, display_name, description, workspace_id, user_id, ui_hints, is_directional)
       values (gen_random_uuid(), 'depends_on', $1, $2, null, 'system', $3::jsonb, true) returning id`,
      [
        GLOBAL_DEPENDS.displayName,
        GLOBAL_DEPENDS.description,
        JSON.stringify(GLOBAL_DEPENDS.uiHints),
      ]
    )
  )[0].id;
}

const reconcile = (definition: Record<string, unknown>) =>
  reconcileWorkspaceFromDefinition({
    workspaceId: WS,
    userId: USER,
    definition: definition as never,
  });

describe("reconcile entityLinks reuse the pod-wide relation def", () => {
  it("never mints a workspace copy of a pod-wide slug, and a re-run wipes nothing", async () => {
    const globalId = await seedGlobalDependsOn();
    const definition = {
      entityLinks: [
        {
          sourceProfileSlug: "task",
          targetProfileSlug: "project",
          type: "depends_on",
          label: "Depends on",
        },
      ],
    };

    const first = await reconcile(definition);
    expect(first.entityLinks.added).toHaveLength(1);
    const second = await reconcile(definition);
    expect(second.entityLinks.skipped).toHaveLength(1);

    const rows = await q(
      `select id, workspace_id, description, ui_hints from relation_defs where slug = 'depends_on'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: globalId,
      workspace_id: null,
      description: GLOBAL_DEPENDS.description,
      ui_hints: GLOBAL_DEPENDS.uiHints,
    });
    const edges = await q(
      `select relation_def_id from profile_relations where source_profile_id = $1 and target_profile_id = $2`,
      [task, project]
    );
    expect(edges).toEqual([{ relation_def_id: globalId }]);
  });

  it("a slug nothing resolves gets one workspace def carrying the template's metadata", async () => {
    const definition = {
      entityLinks: [
        {
          sourceProfileSlug: "project",
          targetProfileSlug: "task",
          type: "traverses",
          label: "Traverses",
        },
      ],
      relationDefs: [
        {
          slug: "traverses",
          displayName: "Traverses",
          description: "A workflow passes through this component",
          uiHints: { inverseLabel: "Traversed by" },
          isDirectional: true,
        },
      ],
    };
    await reconcile(definition);
    await reconcile(definition);

    const rows = await q(
      `select workspace_id, description, ui_hints from relation_defs where slug = 'traverses'`
    );
    expect(rows).toEqual([
      {
        workspace_id: WS,
        description: "A workflow passes through this component",
        ui_hints: { inverseLabel: "Traversed by" },
      },
    ]);
  });
});

describe("RelationDefRepository.create — find-or-update writes only supplied fields", () => {
  it("an omitted description / uiHints / isDirectional is preserved, not wiped", async () => {
    const repo = new RelationDefRepository(h.db as never);
    await repo.create({
      slug: "blocks",
      displayName: "Blocks",
      description: "Prevents the target",
      workspaceId: WS,
      userId: USER,
      uiHints: { inverseLabel: "Blocked by" },
      isDirectional: false,
    });
    const again = await repo.create({
      slug: "blocks",
      displayName: "Blocks",
      workspaceId: WS,
      userId: USER,
    });
    expect(again).toMatchObject({
      description: "Prevents the target",
      uiHints: { inverseLabel: "Blocked by" },
      isDirectional: false,
    });
  });
});

// The install door (`createWorkspaceFromDefinition` step 5) binds its edges
// through this same method; that caller is covered here at the METHOD, not by
// driving the whole install (it is not exercised end to end in this file).
describe("RelationDefRepository.resolveOrCreateForLink — the one entityLink rule", () => {
  it("returns the pod-wide row for a slug it resolves; mints a declared def only when nothing resolves", async () => {
    const globalId = await seedGlobalDependsOn();
    const repo = new RelationDefRepository(h.db as never);
    const declared = [
      {
        slug: "traverses",
        displayName: "Traverses",
        description: "A workflow passes through this component",
        uiHints: { inverseLabel: "Traversed by" },
      },
    ];

    const reused = await repo.resolveOrCreateForLink({
      link: { type: "depends_on", label: "Depends on" },
      declared,
      workspaceId: WS,
      userId: USER,
    });
    expect(reused.id).toBe(globalId);

    const minted = await repo.resolveOrCreateForLink({
      link: { type: "traverses" },
      declared,
      workspaceId: WS,
      userId: USER,
    });
    expect(minted).toMatchObject({
      workspaceId: WS,
      description: "A workflow passes through this component",
      uiHints: { inverseLabel: "Traversed by" },
    });

    const rows = await q(
      `select slug, workspace_id from relation_defs order by slug`
    );
    expect(rows).toEqual([
      { slug: "depends_on", workspace_id: null },
      { slug: "traverses", workspace_id: WS },
    ]);
  });
});
