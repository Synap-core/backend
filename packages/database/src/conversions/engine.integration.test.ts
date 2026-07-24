/**
 * REAL-POSTGRES integration test for the conversion engine — the plan-time guard.
 *
 * WHY THIS EXISTS: engine.test.ts / defer.test.ts drive the engine with a FAKE
 * tagged-template `sql` (a JS handler keyed on query substrings). That proves the
 * JS orchestration but NEVER sends a byte of SQL to a planner — so a Postgres
 * TYPE-INFERENCE error (`could not determine data type of parameter $N`, a bad
 * cast, a wrong operator, an ambiguous bind) sails straight through a green unit
 * run and reaches prod. That is exactly what happened: a `jsonb`-operator /
 * `jsonb_build_object` bind with no `::text` cast planned fine in the fake but
 * blew up on the pod's real planner.
 *
 * WHAT IT DOES: runs every manifest op's SQL against a REAL Postgres planner on
 * an (almost) empty database. On an empty database every op is a 0-row no-op, but
 * Postgres still PLANS each statement — and planning is precisely where the
 * type-inference class fires, BEFORE any row. So looping every op catches the
 * whole class (bad casts / operators / ambiguous binds / typos) for ALL op types.
 *
 * ENGINE: PGlite (@electric-sql/pglite) — real Postgres compiled to WASM,
 * in-process, no server, runs everywhere incl. CI. We deliberately do NOT use
 * pg-mem: it is a JS reimplementation of Postgres and does NOT reproduce real
 * parameter type-inference, so a pg-mem test would be VACUOUS (green on the very
 * SQL that breaks prod). PGlite IS the real planner — verified below: it rejects
 * `jsonb_build_object($1,$2)` with untyped binds exactly as the pod does, and it
 * defaults untyped string params to OID 0 just like postgres.js@3.4.8
 * (`inferType('str') === 0`), so what PGlite rejects, the pod rejects too.
 *
 * The engine talks to postgres.js: tagged templates, nested `sql`-fragments
 * spliced as SQL, `.begin(tx => …)` transactions, and a `.count` on write
 * results. `makePgliteSql` below is a faithful shim of exactly that surface over
 * PGlite (string interpolations become $N binds; fragments splice; arrays/objects
 * pass through untyped — same as postgres.js).
 */

import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "postgres";
import { computeCounts, runConversions } from "./engine.js";
import { CONVERSION_MANIFEST } from "./manifest.js";
import type { ConversionOp } from "./manifest.js";

// ─── postgres.js-shaped `Sql` shim over PGlite ───────────────────────────────
// A tagged-template result is a `Frag`: it carries its raw `strings` + `values`
// and is ALSO thenable (awaiting it flattens → binds → runs). When a `Frag` is
// interpolated into another template (postgres.js fragment composition) it is
// spliced as SQL text rather than bound as a parameter.
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
        if (v instanceof Frag)
          walk(v.strings, v.values); // nested fragment → splice
        else {
          params.push(v);
          text += "$" + params.length; // interpolation → bound param
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
    rows.count = (res as any).affectedRows ?? 0; // postgres.js exposes `.count`
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
  // Single in-process connection → a real BEGIN/COMMIT is enough; `tx` is `sql`.
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

// ─── Minimal schema the ops touch ────────────────────────────────────────────
// Only the tables + columns referenced by engine.ts's SQL, with the TYPES that
// matter to planning (jsonb, uuid[], text[], uuid). Data tables (entities,
// entity_facets, …) stay EMPTY — every op runs as a 0-row no-op; the point is
// that Postgres plans each statement.
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

/**
 * Every slug the manifest references (source, target, family, merge, …). Several
 * ops JS-level short-circuit when their profile SELECT returns zero rows
 * (convertToFacet/convertToKind/dedupe) — so a truly empty DB would never PLAN
 * their inner apply SQL (facet INSERT, entity repoint, …). Seeding ONE active
 * profile row per slug (the DATA tables stay empty) makes each op fall through to
 * its real statements so the planner sees them. convertToFacet also throws if its
 * `targetKindSlug` (person/company) has no active profile — these seeds cover it.
 */
function manifestSlugs(): string[] {
  const s = new Set<string>();
  for (const op of CONVERSION_MANIFEST.ops as ConversionOp[]) {
    const o = op as any;
    if (o.slug) s.add(o.slug);
    if (o.targetKindSlug) s.add(o.targetKindSlug);
    if (o.fromKindSlug) s.add(o.fromKindSlug);
    if (o.intoSlug) s.add(o.intoSlug);
    if (Array.isArray(o.fromSlugs))
      o.fromSlugs.forEach((x: string) => s.add(x));
    if (Array.isArray(o.familySlugs))
      o.familySlugs.forEach((x: string) => s.add(x));
  }
  return [...s];
}

async function setupDb(): Promise<{ db: PGlite; sql: Sql }> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  for (const slug of manifestSlugs()) {
    await db.query(
      `INSERT INTO profiles (slug, display_name, profile_kind, scope, entity_scope, is_active)
       VALUES ($1, $1, 'kind', 'system', 'pod', true)`,
      [slug]
    );
  }
  return { db, sql: makePgliteSql(db) };
}

/** Collect any op whose apply ended in a plan/runtime error, for a clear message. */
function errorsOf(summary: Awaited<ReturnType<typeof runConversions>>) {
  return summary.results
    .filter((r) => r.error)
    .map((r) => `${r.opKey}: ${r.error}`);
}

describe("conversion engine — real-Postgres plan-time guard (PGlite)", () => {
  it("plans EVERY op's dry-run count query without a type/plan error", async () => {
    const { sql } = await setupDb();
    for (const op of CONVERSION_MANIFEST.ops) {
      // Both destructiveTail branches — mergeInto/dedupe count an extra
      // profile-deactivation subquery only under destructiveTail:true.
      for (const destructiveTail of [false, true]) {
        const counts = await computeCounts(sql, op, {
          dryRun: true,
          destructiveTail,
        });
        // A real number-bearing tally object came back → the count query PLANNED
        // and EXECUTED (rather than throwing "could not determine data type…").
        expect(
          counts,
          `computeCounts planned for ${op.opKey} (destructiveTail=${destructiveTail})`
        ).toBeTypeOf("object");
      }
    }
  });

  it("boot-caller path (index.ts: deferDestructive + skipDeferred) is plan-clean", async () => {
    // Exactly how pod boot invokes the engine: defers destructive tails AND
    // skips deferAtBoot cutovers. Plans seed/convertToFacet/convertToKind/
    // reconcile applies as 0-row no-ops.
    const { sql } = await setupDb();
    const summary = await runConversions(sql, CONVERSION_MANIFEST, {
      dryRun: false,
      destructiveTail: false,
      deferDestructive: true,
      skipDeferred: true,
    });
    // On the empty DB every apply is a 0-row no-op, so a recorded error can only
    // be a PLAN-TIME failure (bad cast / operator / ambiguous bind).
    expect(errorsOf(summary), errorsOf(summary).join("\n")).toEqual([]);
    expect(summary.hadError).toBe(false);
  });

  it("operator --apply path plans EVERY op — incl. destructive tails + deferred cutovers", async () => {
    // How `run-conversions.ts --apply` invokes the engine: no skipDeferred (so
    // the deferAtBoot remapPropertyValues APPLY is planned) and destructiveTail
    // (so mergeInto/dedupe apply + their deactivation tail are planned). This is
    // the path that reached prod — the guard that would have caught the incident.
    const { sql } = await setupDb();
    const summary = await runConversions(sql, CONVERSION_MANIFEST, {
      dryRun: false,
      destructiveTail: true,
      deferDestructive: false,
    });
    expect(errorsOf(summary), errorsOf(summary).join("\n")).toEqual([]);
    expect(summary.hadError).toBe(false);
  });

  // ── Non-vacuity: prove the harness actually CATCHES the prod bug class. ──────
  // The historical incident: a `jsonb_build_object($bind, …)` / `jsonb ? $bind`
  // with the bind left UNTYPED → `could not determine data type of parameter $N`.
  // These run the broken and fixed shapes directly against the PGlite planner
  // (NOT engine.ts) to show the guard is real: broken FAILS, cast PASSES.
  it("CATCHES an untyped-bind plan error (and a ::text cast fixes it)", async () => {
    const { db } = await setupDb();
    // BROKEN: targetKey ($2) passed bare as the variadic-`any` key of
    // jsonb_build_object — Postgres cannot infer its type.
    await expect(
      db.query(
        `UPDATE entities e SET properties =
           (COALESCE(e.properties,'{}'::jsonb) - $1)
           || jsonb_build_object($2, ($3::jsonb -> (e.properties->>$1)))
         FROM profiles p WHERE e.profile_id = p.id AND p.slug = $4`,
        ["dealStage", "commercialStage", '{"lead":"draft"}', "deal"]
      )
    ).rejects.toThrow(/could not determine data type of parameter/);

    // FIXED: the same statement with `::text` on the jsonb_build_object key plans.
    await expect(
      db.query(
        `UPDATE entities e SET properties =
           (COALESCE(e.properties,'{}'::jsonb) - $1::text)
           || jsonb_build_object($2::text, ($3::jsonb -> (e.properties->>$1)))
         FROM profiles p WHERE e.profile_id = p.id AND p.slug = $4`,
        ["dealStage", "commercialStage", '{"lead":"draft"}', "deal"]
      )
    ).resolves.toBeDefined();
  });
});
