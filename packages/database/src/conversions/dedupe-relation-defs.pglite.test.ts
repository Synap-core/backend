/**
 * REAL-POSTGRES (PGlite) test for `d5.dedupe.relation-defs` — driven through
 * the REAL `CONVERSION_MANIFEST` op and `runConversions`, never a hand-built op.
 *
 * Pins (schema convergence D5, founder decision 5):
 *   - a REDUNDANT workspace copy of a pod-wide relation def (legacy seeder copy,
 *     or a bare entityLinks mint) is drained — its `profile_relations` edges and
 *     `property_defs.relation_def_id` move onto the pod-wide row — and only
 *     then deleted; no edge is lost to the ON DELETE CASCADE;
 *   - an edge the pod-wide row already has (same source→target) folds into it
 *     (its property_def_id fills the survivor's) instead of cascading silently;
 *   - a CUSTOMIZED copy and a per-template slug with no pod-wide row are
 *     untouched;
 *   - boot defers the op, a dry run writes nothing, an apply without
 *     --destructive-tail is refused, and a second operator run is a no-op.
 *
 * DDL: hand-written with the REAL foreign-key actions from
 * 0000_baseline_schema.sql (profile_relations → CASCADE, property_defs →
 * SET NULL), because those are exactly what makes a naive delete destructive.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { runConversions } from "./engine.js";
import type { RunOptions } from "./engine.js";
import { CONVERSION_MANIFEST } from "./manifest.js";
import type { ConversionManifest } from "./manifest.js";
import { selectManifestOps } from "./select.js";

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
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE relation_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text NOT NULL,
  description text,
  workspace_id uuid,
  user_id text NOT NULL DEFAULT 'u',
  ui_hints jsonb NOT NULL DEFAULT '{}',
  is_directional boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX relation_defs_slug_pod_unique ON relation_defs (slug)
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX relation_defs_slug_workspace_unique
  ON relation_defs (slug, workspace_id) WHERE workspace_id IS NOT NULL;
CREATE TABLE property_defs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text,
  relation_def_id uuid REFERENCES relation_defs(id) ON DELETE SET NULL
);
CREATE TABLE profile_relations (
  source_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  relation_def_id uuid NOT NULL REFERENCES relation_defs(id) ON DELETE CASCADE,
  display_order integer NOT NULL DEFAULT 0,
  property_def_id uuid REFERENCES property_defs(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (source_profile_id, target_profile_id, relation_def_id)
);
`;

const KEY = "d5.dedupe.relation-defs";
const WS_A = "a0000000-0000-4000-8000-00000000000a";
const WS_B = "b0000000-0000-4000-8000-00000000000b";
const WS_C = "c0000000-0000-4000-8000-00000000000c";

/** Exactly how pod boot invokes the engine (apps/api startup/boot-status.ts). */
const BOOT: RunOptions = {
  dryRun: false,
  destructiveTail: false,
  deferDestructive: true,
  skipDeferred: true,
};
const DRY: RunOptions = { dryRun: true, destructiveTail: false };
const APPLY_NO_TAIL: RunOptions = { dryRun: false, destructiveTail: false };
const OPERATOR_TAIL: RunOptions = { dryRun: false, destructiveTail: true };

/** The REAL manifest narrowed to the D5 op, as `--only d5.dedupe.relation-defs`. */
const ONLY: ConversionManifest = selectManifestOps(CONVERSION_MANIFEST, [KEY]);

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
    TRUNCATE profile_relations, property_defs, relation_defs, profiles CASCADE;
  `);
});

afterAll(async () => {
  await db?.close();
});

async function profile(slug: string): Promise<string> {
  const [r] = await q(`INSERT INTO profiles (slug) VALUES ($1) RETURNING id`, [
    slug,
  ]);
  return r.id;
}

async function relDef(
  slug: string,
  workspaceId: string | null,
  f: {
    displayName: string;
    description?: string | null;
    uiHints?: Record<string, unknown>;
    isDirectional?: boolean;
  }
): Promise<string> {
  const [r] = await q(
    `INSERT INTO relation_defs (slug, workspace_id, display_name, description, ui_hints, is_directional)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
    [
      slug,
      workspaceId,
      f.displayName,
      f.description ?? null,
      JSON.stringify(f.uiHints ?? {}),
      f.isDirectional ?? true,
    ]
  );
  return r.id;
}

async function edge(
  src: string,
  tgt: string,
  relationDefId: string,
  propertyDefId: string | null = null
) {
  await q(
    `INSERT INTO profile_relations (source_profile_id, target_profile_id, relation_def_id, property_def_id)
     VALUES ($1, $2, $3, $4)`,
    [src, tgt, relationDefId, propertyDefId]
  );
}

const DEPENDS = {
  displayName: "Depends On",
  description: "This item depends on the target",
  uiHints: { icon: "link", inverseLabel: "Blocks" },
};

/**
 * The founder pod in miniature: a pod-wide `depends_on` with a legacy
 * byte-identical copy (WS_A), a bare entityLinks mint (WS_B) and a customized
 * copy (WS_C); a non-directional pod-wide `relates_to` with a bare directional
 * mint; and a per-template `supports` in two spaces with NO pod-wide row.
 */
async function seedPod() {
  const task = await profile("task");
  const project = await profile("project");
  const goal = await profile("goal");

  const base = await relDef("depends_on", null, DEPENDS);
  const legacy = await relDef("depends_on", WS_A, DEPENDS);
  const bare = await relDef("depends_on", WS_B, { displayName: "depends on" });
  const custom = await relDef("depends_on", WS_C, {
    displayName: "Depends On",
    description: "Waits for the target's sign-off",
  });

  const relBase = await relDef("relates_to", null, {
    displayName: "Relates To",
    isDirectional: false,
  });
  const relBare = await relDef("relates_to", WS_B, {
    displayName: "relates to",
  });

  const supA = await relDef("supports", WS_A, { displayName: "Supports" });
  const supB = await relDef("supports", WS_B, { displayName: "Supports" });

  const [pd] = await q(
    `INSERT INTO property_defs (slug, relation_def_id) VALUES ('blocker', $1) RETURNING id`,
    [legacy]
  );
  const [pdBare] = await q(
    `INSERT INTO property_defs (slug, relation_def_id) VALUES ('waits-on', $1) RETURNING id`,
    [bare]
  );

  await edge(task, project, legacy); // moves onto the base
  await edge(task, goal, bare, pdBare.id); // moves onto the base
  await edge(task, project, bare, pdBare.id); // collides after the legacy move
  await edge(project, goal, custom); // customization — stays
  await edge(task, task, relBare); // moves onto relates_to base
  await edge(goal, goal, supA); // per-template — stays

  return {
    task,
    project,
    goal,
    base,
    legacy,
    bare,
    custom,
    relBase,
    relBare,
    supA,
    supB,
    pd: pd.id as string,
    pdBare: pdBare.id as string,
  };
}

const ids = async () =>
  (await q(`SELECT id FROM relation_defs ORDER BY id`)).map((r) => r.id);
const edgeCount = async () =>
  (await q(`SELECT COUNT(*)::int AS n FROM profile_relations`))[0].n;

describe("d5.dedupe.relation-defs on the real engine", () => {
  it("is in the real manifest exactly once, sweeping every slug", () => {
    expect(ONLY.ops).toHaveLength(1);
    expect(ONLY.ops[0]).toMatchObject({ op: "dedupeRelationDefs" });
    expect("slug" in ONLY.ops[0] ? ONLY.ops[0].slug : undefined).toBe(
      undefined
    );
  });

  it("operator run: redundant copies drained then deleted, every edge survives on the pod-wide row", async () => {
    const s = await seedPod();
    const edgesBefore = await edgeCount();

    const run = await runConversions(sql, ONLY, OPERATOR_TAIL);
    expect(run.hadError).toBe(false);
    expect(run.results[0]).toMatchObject({
      opKey: KEY,
      status: "applied",
      counts: {
        relationDefsCollapsed: 3,
        relationDefsKept: 1,
        profileRelationsRepointed: 3,
        profileRelationsMerged: 1,
        propertyDefRelationsRepointed: 2,
        relationDefsDeleted: 3,
      },
    });

    // The three redundant copies are gone; base, customization, per-template stay.
    expect(await ids()).toEqual(
      [s.base, s.custom, s.relBase, s.supA, s.supB].sort()
    );

    // Edges: only the one true duplicate folded; nothing cascaded.
    expect(await edgeCount()).toBe(edgesBefore - 1);
    const onBase = await q(
      `SELECT source_profile_id AS s, target_profile_id AS t, property_def_id AS pd
       FROM profile_relations WHERE relation_def_id = $1 ORDER BY target_profile_id`,
      [s.base]
    );
    expect(onBase).toHaveLength(2);
    const byTarget = Object.fromEntries(onBase.map((r: any) => [r.t, r.pd]));
    expect(byTarget[s.goal]).toBe(s.pdBare);
    // The collided edge's bound property def filled the survivor's empty one.
    expect(byTarget[s.project]).toBe(s.pdBare);
    expect(
      (
        await q(`SELECT 1 FROM profile_relations WHERE relation_def_id = $1`, [
          s.relBase,
        ])
      ).length
    ).toBe(1);
    expect(
      (
        await q(`SELECT 1 FROM profile_relations WHERE relation_def_id = $1`, [
          s.custom,
        ])
      ).length
    ).toBe(1);
    expect(
      (
        await q(`SELECT 1 FROM profile_relations WHERE relation_def_id = $1`, [
          s.supA,
        ])
      ).length
    ).toBe(1);

    // property_defs pointing at drained copies now point at the base — not NULLed.
    const pds = await q(
      `SELECT id, relation_def_id AS r FROM property_defs ORDER BY slug`
    );
    expect(pds.every((r: any) => r.r === s.base)).toBe(true);
  });

  it("is idempotent: a second operator run is skipped, and a fresh run finds nothing", async () => {
    await seedPod();
    await runConversions(sql, ONLY, OPERATOR_TAIL);
    const before = await ids();

    const again = await runConversions(sql, ONLY, OPERATOR_TAIL);
    expect(again.results[0].status).toBe("skipped");

    await q(`DELETE FROM "_conversions"`);
    const fresh = await runConversions(sql, ONLY, OPERATOR_TAIL);
    expect(fresh.results[0].counts).toMatchObject({
      relationDefsCollapsed: 0,
      relationDefsDeleted: 0,
      relationDefsKept: 1,
    });
    expect(await ids()).toEqual(before);
  });

  it("dry run reports the collapse and writes nothing", async () => {
    await seedPod();
    const before = await ids();
    const edgesBefore = await edgeCount();

    const run = await runConversions(sql, ONLY, DRY);
    expect(run.results[0]).toMatchObject({
      status: "dry-run",
      counts: {
        relationDefsCollapsed: 3,
        relationDefsKept: 1,
        relationDefsDeleted: 0,
      },
    });
    expect(await ids()).toEqual(before);
    expect(await edgeCount()).toBe(edgesBefore);
    expect(
      (await q(`SELECT 1 FROM pg_tables WHERE tablename = '_conversions'`))
        .length
    ).toBe(1);
    expect(await q(`SELECT * FROM "_conversions"`)).toEqual([]);
  });

  it("boot defers it whole; an apply without --destructive-tail is refused, never half-ledgered", async () => {
    await seedPod();
    const before = await ids();

    const boot = await runConversions(sql, ONLY, BOOT);
    expect(boot.results[0]).toMatchObject({
      status: "deferred",
      deferReason: "destructive-tail",
    });

    const noTail = await runConversions(sql, ONLY, APPLY_NO_TAIL);
    expect(noTail.hadError).toBe(true);
    expect(noTail.results[0].error).toMatch(/without destructiveTail/);

    expect(await ids()).toEqual(before);
    expect(await q(`SELECT * FROM "_conversions"`)).toEqual([]);
  });
});
