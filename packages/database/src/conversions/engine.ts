/**
 * Conversion Engine — Kind + Facets Wave 3A
 *
 * Interprets a `ConversionManifest` (manifest.ts) against a live Postgres pod.
 * Mirrors the migration runner's contract, but for DATA rather than DDL:
 *
 *   - Ops run sequentially, each in its own transaction.
 *   - Each op is idempotent; the `_conversions` ledger records applied op keys
 *     (`error IS NULL AND dry_run = false`) and the engine skips them next time.
 *   - `dryRun` (the default at the CLI) computes per-op counts WITHOUT writing
 *     anything — not to the target tables and not to the ledger.
 *   - A real run records one ledger row per op (with its counts). If an op
 *     throws, the failure is recorded (`error` set) in its own statement, the
 *     run stops at that op, and the summary flags it so the CLI exits non-zero.
 *
 * Uses the raw postgres.js client (like migrate.ts) — NOT drizzle — so it can be
 * driven from a script with a single dedicated connection.
 */

import type { Sql } from "postgres";
import type {
  ConversionManifest,
  ConversionOp,
  ConvertToFacetOp,
  MergeIntoOp,
  SeedKindProfileOp,
  DeclareKindOp,
} from "./manifest.js";
import { validateManifest, buildPropertyMappingJson } from "./manifest.js";

/** Per-op tally. Every field optional — an op reports only what it touched. */
export interface OpCounts {
  profilesCreated?: number;
  profilesUpdated?: number;
  profilesDeactivated?: number;
  entitiesConverted?: number;
  entitiesRepointed?: number;
  facetsCreated?: number;
  viewsRewritten?: number;
  propertyDefsRepointed?: number;
  profilePropertiesRepointed?: number;
}

export type OpStatus = "applied" | "skipped" | "dry-run" | "noop" | "error";

export interface OpResult {
  opKey: string;
  op: ConversionOp["op"];
  slug?: string;
  status: OpStatus;
  counts: OpCounts;
  error?: string;
}

export interface RunOptions {
  /** When true (the safe default) compute counts but write nothing. */
  dryRun: boolean;
  /**
   * When true, mergeInto deactivates its source profiles. Requires a real
   * (non-dry) run. Default false — the canary constraint.
   */
  destructiveTail: boolean;
}

export interface RunSummary {
  dryRun: boolean;
  destructiveTail: boolean;
  results: OpResult[];
  /** True if any op ended in `error`. */
  hadError: boolean;
}

/**
 * Ensure the `_conversions` ledger exists. Defensive: migration 0175 (and the
 * baseline) create it, but the engine may be driven in a context where those
 * have not run (e.g. an integration test against a bare schema).
 */
export async function ensureConversionsLedger(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS "_conversions" (
      "id"         serial      PRIMARY KEY,
      "op_key"     text        NOT NULL UNIQUE,
      "applied_at" timestamp with time zone NOT NULL DEFAULT now(),
      "dry_run"    boolean     NOT NULL DEFAULT false,
      "counts"     jsonb       NOT NULL DEFAULT '{}',
      "error"      text
    )
  `;
}

/**
 * Run a manifest. See module header for the contract.
 */
export async function runConversions(
  sql: Sql,
  manifest: ConversionManifest,
  options: RunOptions
): Promise<RunSummary> {
  validateManifest(manifest);
  await ensureConversionsLedger(sql);

  if (options.destructiveTail && options.dryRun) {
    // Harmless (dry-run writes nothing), but the intent is contradictory —
    // surface it rather than silently ignore.
    throw new Error(
      "runConversions: destructiveTail has no effect in a dry run (pass --apply)."
    );
  }

  // Applied set = op keys that succeeded on a previous real run.
  const appliedRows = await sql<Array<{ op_key: string }>>`
    SELECT op_key FROM "_conversions" WHERE error IS NULL AND dry_run = false
  `;
  const applied = new Set(appliedRows.map((r) => r.op_key));

  const results: OpResult[] = [];
  let hadError = false;

  for (const op of manifest.ops) {
    const slug = "slug" in op ? op.slug : undefined;

    if (!options.dryRun && applied.has(op.opKey)) {
      results.push({
        opKey: op.opKey,
        op: op.op,
        slug,
        status: "skipped",
        counts: {},
      });
      continue;
    }

    try {
      if (options.dryRun) {
        const counts = await computeCounts(sql, op, options);
        results.push({
          opKey: op.opKey,
          op: op.op,
          slug,
          status: "dry-run",
          counts,
        });
      } else {
        const counts = await sql.begin(async (tx) => {
          const c = await applyOp(tx as unknown as Sql, op, options);
          await recordLedger(tx as unknown as Sql, op.opKey, c, null);
          return c;
        });
        const isNoop = Object.values(counts as OpCounts).every((v) => !v);
        results.push({
          opKey: op.opKey,
          op: op.op,
          slug,
          status: isNoop ? "noop" : "applied",
          counts: counts as OpCounts,
        });
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      hadError = true;
      if (!options.dryRun) {
        // Record the failure in its own statement (the op tx rolled back).
        try {
          await recordLedger(sql, op.opKey, {}, message);
        } catch {
          /* best-effort — never mask the original error */
        }
      }
      results.push({
        opKey: op.opKey,
        op: op.op,
        slug,
        status: "error",
        counts: {},
        error: message,
      });
      break; // Halt at the first failure (canary posture).
    }
  }

  return {
    dryRun: options.dryRun,
    destructiveTail: options.destructiveTail,
    results,
    hadError,
  };
}

async function recordLedger(
  sql: Sql,
  opKey: string,
  counts: OpCounts,
  error: string | null
): Promise<void> {
  await sql`
    INSERT INTO "_conversions" ("op_key", "dry_run", "counts", "error")
    VALUES (${opKey}, false, ${sql.json(counts as any)}, ${error})
    ON CONFLICT ("op_key") DO UPDATE SET
      "applied_at" = now(),
      "dry_run"    = EXCLUDED."dry_run",
      "counts"     = EXCLUDED."counts",
      "error"      = EXCLUDED."error"
  `;
}

// ─── Apply (real run) ────────────────────────────────────────────────────────

async function applyOp(
  tx: Sql,
  op: ConversionOp,
  options: RunOptions
): Promise<OpCounts> {
  switch (op.op) {
    case "declareKind":
      return applyDeclareKind(tx, op);
    case "seedKindProfile":
      return applySeedKindProfile(tx, op);
    case "convertToFacet":
      return applyConvertToFacet(tx, op);
    case "mergeInto":
      return applyMergeInto(tx, op, options.destructiveTail);
    case "keep":
    case "extractNonEntity":
      return {}; // Ledger-recorded no-op.
  }
}

async function applyDeclareKind(tx: Sql, op: DeclareKindOp): Promise<OpCounts> {
  const counts: OpCounts = {};
  const flip = await tx`
    UPDATE profiles
    SET profile_kind = 'kind', updated_at = now()
    WHERE slug = ${op.slug} AND profile_kind IS DISTINCT FROM 'kind'
  `;
  if (op.protected) {
    const mark = await tx`
      UPDATE profiles
      SET ui_hints = ui_hints || '{"protected": true}'::jsonb, updated_at = now()
      WHERE slug = ${op.slug}
        AND COALESCE((ui_hints->>'protected')::boolean, false) = false
    `;
    counts.profilesUpdated = (flip.count ?? 0) + (mark.count ?? 0);
  } else if (flip.count) {
    counts.profilesUpdated = flip.count;
  }
  return counts;
}

async function applySeedKindProfile(
  tx: Sql,
  op: SeedKindProfileOp
): Promise<OpCounts> {
  const inserted = await tx`
    INSERT INTO profiles (slug, display_name, ui_hints, scope, entity_scope, profile_kind)
    SELECT ${op.slug}, ${op.displayName}, ${tx.json((op.uiHints ?? {}) as any)},
           'system', ${op.entityScope}, 'kind'
    WHERE NOT EXISTS (
      SELECT 1 FROM profiles WHERE slug = ${op.slug} AND scope = 'system'
    )
  `;
  return inserted.count ? { profilesCreated: inserted.count } : {};
}

async function applyConvertToFacet(
  tx: Sql,
  op: ConvertToFacetOp
): Promise<OpCounts> {
  const sId = await resolveProfileId(tx, op.slug);
  if (!sId) return {}; // Nothing on this pod to convert.
  const tId = await resolveProfileId(tx, op.targetKindSlug);
  if (!tId) {
    throw new Error(
      `convertToFacet '${op.opKey}': target kind profile '${op.targetKindSlug}' not found`
    );
  }

  // (a) flip the source profile from kind → role.
  await tx`
    UPDATE profiles
    SET profile_kind = 'role',
        applicable_kinds = ${op.applicableKinds}::text[],
        updated_at = now()
    WHERE id = ${sId}
  `;

  // (b) attach a facet for every live entity still on the source profile.
  const mappingJson = buildPropertyMappingJson(op.propertyMapping);
  const statusExpr = op.statusFrom
    ? tx`e.properties->>${op.statusFrom}`
    : tx`NULL`;
  const contextExpr = op.contextFromProperty
    ? tx`(CASE WHEN e.properties->>${op.contextFromProperty} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN (SELECT ce.id FROM entities ce WHERE ce.id = (e.properties->>${op.contextFromProperty})::uuid)
           ELSE NULL END)`
    : tx`NULL`;

  const facets = await tx`
    INSERT INTO entity_facets
      (entity_id, profile_id, user_id, workspace_id, status, context_entity_id,
       properties, metadata, created_by_kind)
    SELECT
      e.id, ${sId}, e.user_id, e.workspace_id,
      ${statusExpr},
      ${contextExpr},
      COALESCE((
        SELECT jsonb_strip_nulls(jsonb_object_agg(pair->>1, e.properties -> (pair->>0)))
        FROM jsonb_array_elements(${mappingJson}::jsonb) AS pair
        WHERE e.properties ? (pair->>0)
      ), '{}'::jsonb),
      jsonb_build_object('convertedFrom', ${op.slug}::text, 'convertedBy', ${op.opKey}::text),
      'system'
    FROM entities e
    WHERE e.profile_id = ${sId} AND e.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM entity_facets f
        WHERE f.entity_id = e.id AND f.profile_id = ${sId} AND f.deleted_at IS NULL
      )
  `;

  // (c) the entity row itself becomes the target kind.
  const repoint = await tx`
    UPDATE entities e
    SET profile_id = ${tId}, type = ${op.targetKindSlug}, updated_at = now()
    WHERE e.profile_id = ${sId} AND e.deleted_at IS NULL
  `;

  return {
    facetsCreated: facets.count ?? 0,
    entitiesConverted: repoint.count ?? 0,
  };
}

async function applyMergeInto(
  tx: Sql,
  op: MergeIntoOp,
  destructiveTail: boolean
): Promise<OpCounts> {
  const counts: OpCounts = {
    entitiesRepointed: 0,
    propertyDefsRepointed: 0,
    profilePropertiesRepointed: 0,
    viewsRewritten: 0,
    profilesDeactivated: 0,
  };

  for (const from of op.fromSlugs) {
    // profile_properties first (its property_def_id must still resolve), then
    // property_defs, then entities, then views. Each collision-skips.
    const pp = await tx`
      UPDATE profile_properties pp
      SET profile_id = k.id
      FROM profiles src
      JOIN profiles k ON k.slug = ${op.intoSlug} AND k.scope = src.scope
        AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id
      WHERE pp.profile_id = src.id AND src.slug = ${from} AND src.id <> k.id
        AND NOT EXISTS (
          SELECT 1 FROM profile_properties pp2
          WHERE pp2.profile_id = k.id AND pp2.property_def_id = pp.property_def_id
        )
    `;
    counts.profilePropertiesRepointed! += pp.count ?? 0;

    const pd = await tx`
      UPDATE property_defs pd
      SET profile_id = k.id
      FROM profiles src
      JOIN profiles k ON k.slug = ${op.intoSlug} AND k.scope = src.scope
        AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id
      WHERE pd.profile_id = src.id AND src.slug = ${from} AND src.id <> k.id
        AND NOT EXISTS (
          SELECT 1 FROM property_defs pd2
          WHERE pd2.profile_id = k.id AND pd2.slug = pd.slug
            AND pd2.workspace_id IS NOT DISTINCT FROM pd.workspace_id
        )
    `;
    counts.propertyDefsRepointed! += pd.count ?? 0;

    const ent = await tx`
      UPDATE entities e
      SET profile_id = k.id, type = ${op.intoSlug}, updated_at = now()
      FROM profiles src
      JOIN profiles k ON k.slug = ${op.intoSlug} AND k.scope = src.scope
        AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id
      WHERE e.profile_id = src.id AND src.slug = ${from} AND src.id <> k.id
    `;
    counts.entitiesRepointed! += ent.count ?? 0;

    const vw = await tx`
      UPDATE views v
      SET scope_profile_ids = array_replace(v.scope_profile_ids, src.id, k.id)
      FROM profiles src
      JOIN profiles k ON k.slug = ${op.intoSlug} AND k.scope = src.scope
        AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id
      WHERE src.slug = ${from} AND src.id <> k.id
        AND v.scope_profile_ids @> ARRAY[src.id]
    `;
    counts.viewsRewritten! += vw.count ?? 0;

    if (destructiveTail) {
      const deact = await tx`
        UPDATE profiles src
        SET is_active = false, updated_at = now()
        WHERE src.slug = ${from} AND src.is_active = true
          AND EXISTS (
            SELECT 1 FROM profiles k
            WHERE k.slug = ${op.intoSlug} AND k.scope = src.scope
              AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id
              AND k.id <> src.id
          )
      `;
      counts.profilesDeactivated! += deact.count ?? 0;
    }
  }

  return counts;
}

// ─── Dry-run counting (no writes) ────────────────────────────────────────────

async function computeCounts(
  sql: Sql,
  op: ConversionOp,
  options: RunOptions
): Promise<OpCounts> {
  switch (op.op) {
    case "declareKind": {
      const r = await sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM profiles
        WHERE slug = ${op.slug} AND profile_kind IS DISTINCT FROM 'kind'
      `;
      return r[0]?.n ? { profilesUpdated: r[0].n } : {};
    }
    case "seedKindProfile": {
      const r = await sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM profiles
        WHERE slug = ${op.slug} AND scope = 'system'
      `;
      return (r[0]?.n ?? 0) === 0 ? { profilesCreated: 1 } : {};
    }
    case "convertToFacet": {
      const sId = await resolveProfileId(sql, op.slug);
      if (!sId) return {};
      const r = await sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM entities e
        WHERE e.profile_id = ${sId} AND e.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM entity_facets f
            WHERE f.entity_id = e.id AND f.profile_id = ${sId} AND f.deleted_at IS NULL
          )
      `;
      const n = r[0]?.n ?? 0;
      return { entitiesConverted: n, facetsCreated: n };
    }
    case "mergeInto":
      return computeMergeCounts(sql, op, options.destructiveTail);
    case "keep":
    case "extractNonEntity":
      return {};
  }
}

async function computeMergeCounts(
  sql: Sql,
  op: MergeIntoOp,
  destructiveTail: boolean
): Promise<OpCounts> {
  const counts: OpCounts = {
    entitiesRepointed: 0,
    propertyDefsRepointed: 0,
    profilePropertiesRepointed: 0,
    viewsRewritten: 0,
    profilesDeactivated: 0,
  };
  for (const from of op.fromSlugs) {
    const ent = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM entities e
      JOIN profiles src ON src.id = e.profile_id AND src.slug = ${from}
      WHERE EXISTS (
        SELECT 1 FROM profiles k WHERE k.slug = ${op.intoSlug} AND k.scope = src.scope
          AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id AND k.id <> src.id
      )
    `;
    counts.entitiesRepointed! += ent[0]?.n ?? 0;

    const pd = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM property_defs pd
      JOIN profiles src ON src.id = pd.profile_id AND src.slug = ${from}
      JOIN profiles k ON k.slug = ${op.intoSlug} AND k.scope = src.scope
        AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id AND k.id <> src.id
      WHERE NOT EXISTS (
        SELECT 1 FROM property_defs pd2 WHERE pd2.profile_id = k.id AND pd2.slug = pd.slug
          AND pd2.workspace_id IS NOT DISTINCT FROM pd.workspace_id
      )
    `;
    counts.propertyDefsRepointed! += pd[0]?.n ?? 0;

    const pp = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM profile_properties pp
      JOIN profiles src ON src.id = pp.profile_id AND src.slug = ${from}
      JOIN profiles k ON k.slug = ${op.intoSlug} AND k.scope = src.scope
        AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id AND k.id <> src.id
      WHERE NOT EXISTS (
        SELECT 1 FROM profile_properties pp2 WHERE pp2.profile_id = k.id AND pp2.property_def_id = pp.property_def_id
      )
    `;
    counts.profilePropertiesRepointed! += pp[0]?.n ?? 0;

    const vw = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n FROM views v
      JOIN profiles src ON src.slug = ${from} AND v.scope_profile_ids @> ARRAY[src.id]
      WHERE EXISTS (
        SELECT 1 FROM profiles k WHERE k.slug = ${op.intoSlug} AND k.scope = src.scope
          AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id AND k.id <> src.id
      )
    `;
    counts.viewsRewritten! += vw[0]?.n ?? 0;

    if (destructiveTail) {
      const dc = await sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM profiles src
        WHERE src.slug = ${from} AND src.is_active = true
          AND EXISTS (
            SELECT 1 FROM profiles k WHERE k.slug = ${op.intoSlug} AND k.scope = src.scope
              AND k.is_active = true AND k.workspace_id IS NOT DISTINCT FROM src.workspace_id AND k.id <> src.id
          )
      `;
      counts.profilesDeactivated! += dc[0]?.n ?? 0;
    }
  }
  return counts;
}

/**
 * Resolve a profile id by slug among active profiles, preferring the widest
 * scope (system > shared > workspace > user) then the oldest row. Returns null
 * when no active profile carries the slug.
 */
async function resolveProfileId(
  sql: Sql,
  slug: string
): Promise<string | null> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM profiles
    WHERE slug = ${slug} AND is_active = true
    ORDER BY CASE scope
        WHEN 'system' THEN 0 WHEN 'shared' THEN 1
        WHEN 'workspace' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}
