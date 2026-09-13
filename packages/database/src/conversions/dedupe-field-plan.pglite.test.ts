/**
 * REAL-POSTGRES (PGlite) test for the dedupeProfileRows FIELD repoint and its
 * field-level dry run.
 *
 * The defect it pins: dedupeProfileRows repointed a WORKSPACE twin's property
 * defs onto the pod-wide system row WITHOUT re-stamping workspace_id, and its
 * collision guard was case-sensitive. On the live pod that would have turned the
 * Pod Admin knowledge twin's base def `knowledgeform` into a POD-WIDE def beside
 * the system `knowledgeForm`, and the CRM campaign twin's six base defs into
 * pod-wide fields of every workspace's `campaign`.
 *
 * Reachability, not shape: the leak is asserted through the lens a reader uses
 * (`getEffectiveProperties` = the canonical's LINKS, filtered to base defs plus
 * the reader's own overlays), from a workspace that never had the twin.
 *
 * The seed mirrors production's partial unique indexes on property_defs, so the
 * ambiguity rule is proven against the constraint it exists to avoid.
 *
 * One PGlite per file (tables truncated between tests), not one per test.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { runConversions } from "./engine.js";
import type { ConversionManifest } from "./manifest.js";

// ─── postgres.js-shaped `Sql` shim over PGlite ───────────────────────────────
// Same contract as merge-cross-scope.test.ts / engine.integration.test.ts.
class Frag {
  constructor(
    readonly strings: readonly string[],
    readonly values: unknown[]
  ) {}
}

function flatten(frag: Frag): { text: string; params: unknown[] } {
  let text = "";
  const params: unknown[] = [];
  const walk = (strings: readonly string[], values: unknown[]) => {
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        const v = values[i];
        if (v instanceof Frag) walk(v.strings, v.values);
        else {
          params.push(v);
          text += "$" + params.length;
        }
      }
    }
  };
  walk(frag.strings, frag.values);
  return { text, params };
}

function makePgliteSql(db: PGlite): Sql {
  const exec = async (text: string, params: unknown[]) => {
    const res = await db.query(text, params);
    const rows: any = res.rows ?? [];
    rows.count = (res as any).affectedRows ?? 0;
    return rows;
  };
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: any = new Frag(strings as unknown as string[], values);
    frag.then = (resolve: any, reject: any) => {
      const { text, params } = flatten(frag);
      return exec(text, params).then(resolve, reject);
    };
    return frag;
  };
  sql.begin = async (fn: (tx: Sql) => Promise<unknown>) => {
    await exec("BEGIN", []);
    try {
      const r = await fn(sql);
      await exec("COMMIT", []);
      return r;
    } catch (e) {
      await exec("ROLLBACK", []);
      throw e;
    }
  };
  return sql as Sql;
}

const SCHEMA = `
CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text,
  profile_kind text DEFAULT 'kind',
  scope text DEFAULT 'system',
  entity_scope text DEFAULT 'pod',
  workspace_id uuid,
  is_active boolean DEFAULT true,
  applicable_kinds text[],
  ui_hints jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  user_id uuid,
  workspace_id uuid,
  type text,
  properties jsonb DEFAULT '{}',
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE entity_facets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid,
  profile_id uuid,
  user_id uuid,
  workspace_id uuid,
  status text,
  context_entity_id uuid,
  properties jsonb DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  created_by_kind text,
  deleted_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE property_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  slug text,
  workspace_id uuid
);
-- production's scoping indexes (schema/property-defs.ts)
CREATE UNIQUE INDEX pd_base ON property_defs (slug, profile_id)
  WHERE workspace_id IS NULL AND profile_id IS NOT NULL;
CREATE UNIQUE INDEX pd_overlay ON property_defs (slug, profile_id, workspace_id)
  WHERE workspace_id IS NOT NULL AND profile_id IS NOT NULL;
CREATE TABLE profile_properties (
  profile_id uuid NOT NULL,
  property_def_id uuid NOT NULL,
  PRIMARY KEY (profile_id, property_def_id)
);
CREATE TABLE views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_profile_ids uuid[] DEFAULT '{}'
);
`;

const WS_ADMIN = "1aec31d8-0000-4000-8000-000000000001";
const WS_OTHER = "99999999-0000-4000-8000-000000000009";

let db: PGlite;
let sql: Sql;
const q = async (text: string, params: unknown[] = []) =>
  (await db.query(text, params)).rows as any[];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  sql = makePgliteSql(db);
}, 120_000);

beforeEach(async () => {
  await db.exec(`
    DROP TABLE IF EXISTS "_conversions";
    TRUNCATE profiles, entities, entity_facets, property_defs, profile_properties, views;
  `);
});

afterAll(async () => {
  await db?.close();
});

async function def(
  profileId: string | null,
  slug: string,
  workspaceId: string | null,
  linkTo: string[] = []
): Promise<string> {
  const [row] = await q(
    `INSERT INTO property_defs (profile_id, slug, workspace_id) VALUES ($1,$2,$3) RETURNING id`,
    [profileId, slug, workspaceId]
  );
  for (const p of linkTo) {
    await q(
      `INSERT INTO profile_properties (profile_id, property_def_id) VALUES ($1,$2)`,
      [p, row.id]
    );
  }
  return row.id;
}

/**
 * The live Pod Admin shape: the system `knowledge` row (base `knowledgeForm`),
 * and a later WORKSPACE twin carrying a base `knowledgeform` (folds together), a
 * base `summary` (must become a WS_ADMIN overlay), a WS_ADMIN overlay
 * `sourceUrl`, and a link to a GLOBAL `description` def.
 */
async function seedKnowledgeTwin() {
  const [system] = await q(
    `INSERT INTO profiles (slug, scope, workspace_id, created_at)
     VALUES ('knowledge','system',NULL, now() - interval '1 day') RETURNING id`
  );
  const [twin] = await q(
    `INSERT INTO profiles (slug, scope, entity_scope, workspace_id)
     VALUES ('knowledge','workspace','workspace',$1) RETURNING id`,
    [WS_ADMIN]
  );
  await def(system.id, "knowledgeForm", null, [system.id]);
  await def(twin.id, "knowledgeform", null, [twin.id]);
  await def(twin.id, "summary", null, [twin.id]);
  await def(twin.id, "sourceUrl", WS_ADMIN, [twin.id]);
  await def(null, "description", null, [twin.id]);
  for (const props of [
    { knowledgeform: "lesson", summary: "a" },
    { knowledgeform: "gotcha" },
  ]) {
    await q(
      `INSERT INTO entities (profile_id, workspace_id, type, properties) VALUES ($1,$2,'knowledge',$3)`,
      [twin.id, WS_ADMIN, JSON.stringify(props)]
    );
  }
  return { systemId: system.id as string, twinId: twin.id as string };
}

/** What a reader in `workspaceId` sees on a profile: links → base defs + its own overlays. */
async function fieldsVisibleIn(profileId: string, workspaceId: string) {
  const rows = await q(
    `SELECT pd.slug FROM profile_properties pp
     JOIN property_defs pd ON pd.id = pp.property_def_id
     WHERE pp.profile_id = $1 AND (pd.workspace_id IS NULL OR pd.workspace_id = $2)
     ORDER BY pd.slug`,
    [profileId, workspaceId]
  );
  return rows.map((r) => r.slug);
}

const DEDUPE_KNOWLEDGE = {
  op: "dedupeProfileRows",
  opKey: "test.dedupe.knowledge",
  slug: "knowledge",
  canonical: "system",
} as const;

const manifestOf = (
  op: ConversionManifest["ops"][number]
): ConversionManifest => ({
  version: 1,
  ops: [op],
});

const byKey = (rows: any[]) =>
  Object.fromEntries(rows.map((r) => [`${r.table}:${r.slug}`, r]));

describe("dedupeProfileRows — field repoint never widens a lens", () => {
  it("dry run lists the restamp, the folded collision and the widening link — and writes nothing", async () => {
    const { twinId } = await seedKnowledgeTwin();

    const summary = await runConversions(sql, manifestOf(DEDUPE_KNOWLEDGE), {
      dryRun: true,
      destructiveTail: false,
    });
    const r = summary.results[0];
    expect(r.error ?? null, r.error ?? "").toBeNull();
    expect(r.status).toBe("dry-run");
    const plan = byKey(r.planDetail ?? []);
    expect(Object.keys(plan).sort()).toEqual([
      "profile_properties:description",
      "property_defs:knowledgeform",
      "property_defs:sourceUrl",
      "property_defs:summary",
    ]);
    expect(plan["property_defs:summary"]).toMatchObject({
      action: "restamped",
      fromWorkspaceId: null,
      toWorkspaceId: WS_ADMIN,
    });
    expect(plan["property_defs:sourceUrl"]).toMatchObject({
      action: "moved",
      fromWorkspaceId: WS_ADMIN,
      toWorkspaceId: WS_ADMIN,
    });
    expect(plan["property_defs:knowledgeform"]).toMatchObject({
      action: "collision-skipped",
      collidesWith: "knowledgeForm",
      entitiesWithKey: 2,
    });
    expect(plan["profile_properties:description"]).toMatchObject({
      action: "widen-skipped",
      entitiesWithKey: 0,
    });
    expect(r.counts.propertyDefsRepointed).toBe(2);
    expect(r.counts.entitiesRepointed).toBe(2);

    // Rolled back: every def still on the twin, nothing ledgered.
    const onTwin = await q(
      `SELECT slug FROM property_defs WHERE profile_id = $1 ORDER BY slug`,
      [twinId]
    );
    expect(onTwin.map((x) => x.slug)).toEqual([
      "knowledgeform",
      "sourceUrl",
      "summary",
    ]);
    expect(await q(`SELECT op_key FROM "_conversions"`)).toEqual([]);
  });

  it("apply: no pod-wide `knowledgeform`, the twin's defs are overlays on the canonical, and the plan equals the dry run", async () => {
    const { systemId, twinId } = await seedKnowledgeTwin();

    const dry = await runConversions(sql, manifestOf(DEDUPE_KNOWLEDGE), {
      dryRun: true,
      destructiveTail: false,
    });
    const applied = await runConversions(sql, manifestOf(DEDUPE_KNOWLEDGE), {
      dryRun: false,
      destructiveTail: true,
    });
    const r = applied.results[0];
    expect(r.error ?? null, r.error ?? "").toBeNull();
    expect(r.status).toBe("applied");
    // Derived, not mirrored: the dry run said exactly what the apply did.
    expect(r.planDetail).toEqual(dry.results[0].planDetail);

    // No POD-WIDE def other than the system's own.
    const podWide = await q(
      `SELECT slug FROM property_defs WHERE profile_id = $1 AND workspace_id IS NULL`,
      [systemId]
    );
    expect(podWide.map((x) => x.slug)).toEqual(["knowledgeForm"]);

    // The twin's workspace defs are now overlays on the canonical row.
    const overlays = await q(
      `SELECT slug, workspace_id FROM property_defs WHERE profile_id = $1 AND workspace_id IS NOT NULL ORDER BY slug`,
      [systemId]
    );
    expect(overlays).toEqual([
      { slug: "sourceUrl", workspace_id: WS_ADMIN },
      { slug: "summary", workspace_id: WS_ADMIN },
    ]);

    // Reachability through the reader's lens.
    expect(await fieldsVisibleIn(systemId, WS_OTHER)).toEqual([
      "knowledgeForm",
    ]);
    expect(await fieldsVisibleIn(systemId, WS_ADMIN)).toEqual([
      "knowledgeForm",
      "sourceUrl",
      "summary",
    ]);

    // The folded collision was left behind, not duplicated.
    const [left] = await q(
      `SELECT profile_id, workspace_id FROM property_defs WHERE slug = 'knowledgeform'`
    );
    expect(left).toEqual({ profile_id: twinId, workspace_id: null });

    // Idempotent: the SQL itself is a no-op the second time.
    await q(`DELETE FROM "_conversions"`);
    const again = await runConversions(sql, manifestOf(DEDUPE_KNOWLEDGE), {
      dryRun: false,
      destructiveTail: true,
    });
    expect(again.results[0].status).toBe("noop");
  });

  // Fold-distinct slugs (`startDate` / `start_date`) are invisible to the unique
  // index, so without the rule both would land as two WS_ADMIN overlays of one
  // field. Exact-equal slugs would additionally abort the op on the index.
  it("two twins in one workspace folding to the same key → ambiguous, neither moves", async () => {
    const [system] = await q(
      `INSERT INTO profiles (slug, scope, created_at) VALUES ('campaign','system', now() - interval '1 day') RETURNING id`
    );
    const twins: string[] = [];
    for (const slug of ["startDate", "start_date"]) {
      const [t] = await q(
        `INSERT INTO profiles (slug, scope, workspace_id) VALUES ('campaign','workspace',$1) RETURNING id`,
        [WS_ADMIN]
      );
      twins.push(t.id);
      await def(t.id, slug, null, [t.id]);
    }

    const summary = await runConversions(
      sql,
      manifestOf({
        ...DEDUPE_KNOWLEDGE,
        opKey: "test.dedupe.campaign",
        slug: "campaign",
      }),
      { dryRun: false, destructiveTail: true }
    );
    const r = summary.results[0];
    expect(r.error ?? null, r.error ?? "").toBeNull();
    expect((r.planDetail ?? []).map((p) => p.action)).toEqual([
      "ambiguous-skipped",
      "ambiguous-skipped",
    ]);
    expect(
      await q(`SELECT slug FROM property_defs WHERE profile_id = $1`, [
        system.id,
      ])
    ).toEqual([]);
  });
});
