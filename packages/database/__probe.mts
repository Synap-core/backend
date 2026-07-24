import { PGlite } from "@electric-sql/pglite";
import { computeCounts, runConversions } from "./src/conversions/engine.js";
import {
  CONVERSION_MANIFEST,
  type ConversionOp,
} from "./src/conversions/manifest.js";

// ── postgres.js-shaped shim over PGlite ──────────────────────────────────────
class Frag {
  constructor(
    public strings: readonly string[],
    public values: unknown[]
  ) {}
}
function build(frag: Frag) {
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
function makeSql(db: PGlite) {
  const exec = async (text: string, params: unknown[]) => {
    const res = await db.query(text, params);
    const rows: any = res.rows ?? [];
    rows.count = (res as any).affectedRows ?? 0;
    return rows;
  };
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: any = new Frag(strings as unknown as string[], values);
    frag.then = (resolve: any, reject: any) => {
      const { text, params } = build(frag);
      return exec(text, params).then(resolve, reject);
    };
    return frag;
  };
  sql.begin = async (fn: any) => {
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
  return sql;
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
CREATE TABLE profile_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid,
  property_def_id uuid
);
CREATE TABLE views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_profile_ids uuid[] DEFAULT '{}'
);
`;

function slugsFromManifest(): string[] {
  const s = new Set<string>();
  for (const op of CONVERSION_MANIFEST.ops as ConversionOp[]) {
    if ("slug" in op && op.slug) s.add(op.slug);
    if ("targetKindSlug" in op && op.targetKindSlug) s.add(op.targetKindSlug);
    if ("fromKindSlug" in op && op.fromKindSlug) s.add(op.fromKindSlug);
    if ("intoSlug" in op && op.intoSlug) s.add(op.intoSlug);
    if ("fromSlugs" in op && Array.isArray(op.fromSlugs))
      op.fromSlugs.forEach((x) => s.add(x));
    if ("familySlugs" in op && Array.isArray(op.familySlugs))
      op.familySlugs.forEach((x) => s.add(x));
  }
  return [...s];
}

async function freshDb() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const slug of slugsFromManifest()) {
    await db.query(
      `INSERT INTO profiles (slug, display_name, profile_kind, scope, entity_scope, is_active) VALUES ($1,$1,'kind','system','pod',true)`,
      [slug]
    );
  }
  return db;
}

(async () => {
  // 1. dry-run computeCounts for EVERY op
  {
    const db = await freshDb();
    const sql = makeSql(db);
    for (const op of CONVERSION_MANIFEST.ops) {
      for (const destructiveTail of [false, true]) {
        const r = await computeCounts(sql, op as any, {
          dryRun: true,
          destructiveTail,
        });
        if (typeof r !== "object")
          throw new Error(`computeCounts ${op.opKey} returned non-object`);
      }
    }
    console.log("PASS: computeCounts planned for all", CONVERSION_MANIFEST.ops.length, "ops x2");
  }
  // 2. apply run — boot shape (deferDestructive)
  {
    const db = await freshDb();
    const sql = makeSql(db);
    const summary = await runConversions(sql, CONVERSION_MANIFEST, {
      dryRun: false,
      destructiveTail: false,
      deferDestructive: true,
    });
    console.log("PASS: runConversions deferDestructive hadError=", summary.hadError);
    if (summary.hadError) {
      for (const r of summary.results) if (r.error) console.log("  ERR", r.opKey, r.error);
    }
  }
  // 3. apply run — destructiveTail (plans merge/dedupe applies + tails + remap)
  {
    const db = await freshDb();
    const sql = makeSql(db);
    const summary = await runConversions(sql, CONVERSION_MANIFEST, {
      dryRun: false,
      destructiveTail: true,
      deferDestructive: false,
    });
    console.log("PASS: runConversions destructiveTail hadError=", summary.hadError);
    if (summary.hadError) {
      for (const r of summary.results) if (r.error) console.log("  ERR", r.opKey, r.error);
    }
  }

  // 4. NON-VACUITY: probe broken mutations of real engine queries
  console.log("\n--- non-vacuity probes ---");
  const db = await freshDb();
  const probes: Array<[string, string, unknown[]]> = [
    ["remap ? without ::jsonb (broken)", "SELECT count(*) FROM entities e WHERE $1 ? (e.properties->>$2)", ["{}", "k"]],
    ["remap ? WITH ::jsonb (fixed)", "SELECT count(*) FROM entities e WHERE $1::jsonb ? (e.properties->>$2)", ["{}", "k"]],
    ["applicable_kinds = $1 no cast (broken?)", "UPDATE profiles SET applicable_kinds = $1 WHERE slug='x'", [["a", "b"]]],
    ["applicable_kinds = $1::text[] (fixed)", "UPDATE profiles SET applicable_kinds = $1::text[] WHERE slug='x'", [["a", "b"]]],
    ["ANY($1) no cast (broken?)", "SELECT count(*) FROM profiles WHERE slug = ANY($1)", [["a", "b"]]],
    ["ANY($1::text[]) (fixed)", "SELECT count(*) FROM profiles WHERE slug = ANY($1::text[])", [["a", "b"]]],
    ["jsonb_object_agg bare binds (broken)", "SELECT jsonb_object_agg($1,$2) FROM entities", ["a", "b"]],
  ];
  for (const [name, q, args] of probes) {
    try {
      await db.query(q, args);
      console.log("  PASS ", name);
    } catch (e: any) {
      console.log("  FAIL ", name, "::", e.message);
    }
  }
})().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
