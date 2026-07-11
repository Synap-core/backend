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
  DedupeProfileRowsOp,
  ReconcileEntityScopeOp,
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
  facetsRepointed?: number;
  entitiesRescoped?: number;
  viewsRewritten?: number;
  propertyDefsRepointed?: number;
  profilePropertiesRepointed?: number;
}

export type OpStatus =
  | "applied"
  | "skipped"
  | "dry-run"
  | "noop"
  | "deferred"
  | "error";

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
  /**
   * When true, ops that carry a destructive tail (see `opHasDestructiveTail`)
   * are SKIPPED entirely with status "deferred" — neither applied nor recorded
   * in the ledger — so a deliberate operator run can still complete them with
   * --destructive-tail. The automatic pod-startup caller sets this; the CLI
   * does not. Applying only the non-destructive half of such an op would ledger
   * its opKey and orphan the deactivation (a later operator run would skip it),
   * so those ops are deferred whole. Mutually exclusive with `destructiveTail`.
   */
  deferDestructive?: boolean;
}

/**
 * Does this op carry a DESTRUCTIVE tail — a step gated behind the
 * `destructiveTail` run flag that deactivates (retires) profile rows?
 *
 * Exactly the two ops whose `applyOp` handler reads `destructiveTail`:
 * `mergeInto` (deactivates the merged-away source profiles) and
 * `dedupeProfileRows` (deactivates the drained duplicate rows). This IS the
 * engine's existing classification — it just names the same `if
 * (destructiveTail)` branches those two handlers already contain, so the
 * startup caller and the CLI share one definition of "destructive".
 */
export function opHasDestructiveTail(op: ConversionOp): boolean {
  return op.op === "mergeInto" || op.op === "dedupeProfileRows";
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

  if (options.deferDestructive && options.destructiveTail) {
    // Contradictory: defer SKIPS destructive-tail ops, destructiveTail APPLIES
    // their tail. A caller asking for both is confused — fail loudly.
    throw new Error(
      "runConversions: deferDestructive and destructiveTail are mutually exclusive."
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

    // Not-yet-applied op with a destructive tail, and the caller asked to defer:
    // leave it for a deliberate operator run (neither apply nor ledger it).
    if (options.deferDestructive && opHasDestructiveTail(op)) {
      results.push({
        opKey: op.opKey,
        op: op.op,
        slug,
        status: "deferred",
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
  // NEVER use sql.json()/tx.json() in this module: postgres.js 3.4.8 fails to
  // serialize the json Parameter on the pod's driver (Buffer.byteLength gets
  // the raw object at Bind → "string argument must be of type string" → boot
  // abort). Pass pre-stringified JSON with an explicit ::jsonb cast instead.
  await sql`
    INSERT INTO "_conversions" ("op_key", "dry_run", "counts", "error")
    VALUES (${opKey}, false, ${JSON.stringify(counts)}::jsonb, ${error})
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
    case "dedupeProfileRows":
      return applyDedupeProfileRows(tx, op, options.destructiveTail);
    case "reconcileEntityScope":
      return applyReconcileEntityScope(tx, op);
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
    SELECT ${op.slug}, ${op.displayName}, ${JSON.stringify(op.uiHints ?? {})}::jsonb,
           'system', ${op.entityScope}, 'kind'
    WHERE NOT EXISTS (
      SELECT 1 FROM profiles WHERE slug = ${op.slug} AND scope = 'system'
    )
  `;
  return inserted.count ? { profilesCreated: inserted.count } : {};
}

/**
 * Convert EVERY same-slug source profile row into a role and re-home its
 * entities onto the target kind.
 *
 * A single source slug can be carried by several profile rows: `contact` is a
 * SYSTEM profile (one row pod-wide), but `client`/`partner`/`sponsor`/… only
 * exist as WORKSPACE-scope profiles baked into workspace templates, so a pod
 * with N workspaces built from the same template has N rows sharing the slug.
 * Likewise a slug can have both a system row and a workspace-scope duplicate
 * (e.g. the perso pod's two `knowledge` rows). We enumerate ALL active rows for
 * the slug and apply the flip + facet-attach + entity-repoint to each.
 *
 * Per-row semantics:
 *   (a) THIS source row flips to profile_kind='role' with `applicableKinds`
 *       (same values on every row).
 *   (b) each live entity on this row gets a facet whose profile_id = THIS source
 *       row — preserving the workspace-scoped role definition the entity was on.
 *   (c) the entity row is repointed to the target kind resolved for THIS row's
 *       scope (see resolveTargetProfileId): a workspace-scope target in the same
 *       workspace wins, else the system/global target.
 *
 * Transaction / retry: the whole op runs in ONE transaction (runConversions
 * wraps applyOp in `sql.begin`), so all rows commit together or roll back
 * together. A failure on any row aborts the op, the ledger row is never written,
 * and a re-run reprocesses every row from scratch — retry-safe. Idempotency
 * holds too: after (c) no entity remains on any source row, and re-flipping an
 * already-role profile is a no-op, so a second run selects empty sets → noop.
 */
export async function applyConvertToFacet(
  tx: Sql,
  op: ConvertToFacetOp
): Promise<OpCounts> {
  const sourceRows = await tx<
    Array<{ id: string; workspace_id: string | null; entity_scope: string }>
  >`
    SELECT id, workspace_id, entity_scope FROM profiles
    WHERE slug = ${op.slug} AND is_active = true
  `;
  if (sourceRows.length === 0) return {}; // Nothing on this pod to convert.

  // Parse back to a VALUE and pass via tx.json(): postgres.js JSON-serializes
  // a param it infers as jsonb, so handing it the pre-stringified mapping
  // double-encodes into a quoted scalar and jsonb_array_elements throws
  // "cannot extract elements from a scalar" (verified live, postgres@3.4.8).
  // buildPropertyMappingJson stays the tested SSOT for pair building/ordering.
  const mappingPairs = JSON.parse(
    buildPropertyMappingJson(op.propertyMapping)
  ) as Array<[string, string]>;
  // Scope-independent expressions — built once, reused for every source row.
  const statusExpr = op.statusFrom
    ? tx`e.properties->>${op.statusFrom}`
    : tx`NULL`;
  const contextExpr = op.contextFromProperty
    ? tx`(CASE WHEN e.properties->>${op.contextFromProperty} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN (SELECT ce.id FROM entities ce WHERE ce.id = (e.properties->>${op.contextFromProperty})::uuid)
           ELSE NULL END)`
    : tx`NULL`;

  let facetsCreated = 0;
  let entitiesConverted = 0;

  for (const src of sourceRows) {
    // Resolve the target kind for THIS row's scope: prefer a workspace-scope
    // target in the same workspace, fall back to the system/global one.
    const tId = await resolveTargetProfileId(
      tx,
      op.targetKindSlug,
      src.workspace_id
    );
    if (!tId) {
      throw new Error(
        `convertToFacet '${op.opKey}': target kind profile '${op.targetKindSlug}' not found for source profile ${src.id}`
      );
    }

    // (a) flip THIS source row from kind → role.
    await tx`
      UPDATE profiles
      SET profile_kind = 'role',
          applicable_kinds = ${op.applicableKinds}::text[],
          updated_at = now()
      WHERE id = ${src.id}
    `;

    // (b) attach a facet (profile_id = this source row) for every live entity
    // still on it.
    //
    // Facet workspace lens must PRESERVE the entity's pre-conversion
    // visibility: a pod-scoped source profile made its entities visible in
    // every workspace, so the facet must be pod-wide too (workspace_id NULL +
    // owner floor) or the entity vanishes from every other workspace's
    // role-filtered reads (verified live: 393/400 converted facets were
    // workspace-stamped and lost cross-workspace visibility). A
    // workspace-scoped source profile keeps the entity's workspace lens.
    const facetWorkspaceExpr =
      src.entity_scope === "pod" ? tx`NULL` : tx`e.workspace_id`;
    const facets = await tx`
      INSERT INTO entity_facets
        (entity_id, profile_id, user_id, workspace_id, status, context_entity_id,
         properties, metadata, created_by_kind)
      SELECT
        e.id, ${src.id}, e.user_id, ${facetWorkspaceExpr},
        ${statusExpr},
        ${contextExpr},
        COALESCE((
          SELECT jsonb_strip_nulls(jsonb_object_agg(pair->>1, e.properties -> (pair->>0)))
          FROM jsonb_array_elements(${JSON.stringify(mappingPairs)}::jsonb) AS pair
          WHERE e.properties ? (pair->>0)
        ), '{}'::jsonb),
        jsonb_build_object('convertedFrom', ${op.slug}::text, 'convertedBy', ${op.opKey}::text),
        'system'
      FROM entities e
      WHERE e.profile_id = ${src.id} AND e.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM entity_facets f
          WHERE f.entity_id = e.id AND f.profile_id = ${src.id} AND f.deleted_at IS NULL
        )
    `;
    facetsCreated += facets.count ?? 0;

    // (c) the entity rows on this source row become the target kind.
    const repoint = await tx`
      UPDATE entities e
      SET profile_id = ${tId}, type = ${op.targetKindSlug}, updated_at = now()
      WHERE e.profile_id = ${src.id} AND e.deleted_at IS NULL
    `;
    entitiesConverted += repoint.count ?? 0;
  }

  return { facetsCreated, entitiesConverted };
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

/**
 * Resolve the canonical (surviving) profile id for a same-slug dedup, and the
 * ids of the active duplicates to drain into it. `system` prefers the
 * `scope='system'` row (fallback earliest `created_at`); `earliest` takes the
 * earliest outright. Returns null canonical when the slug has no active row.
 */
async function resolveDedupTarget(
  tx: Sql,
  slug: string,
  canonical: "system" | "earliest"
): Promise<{ canonicalId: string | null; otherCount: number }> {
  // Two complete queries rather than an interpolated ORDER BY fragment — keeps
  // the ordering literal and avoids any dynamic-fragment surprises.
  const rows =
    canonical === "system"
      ? await tx<Array<{ id: string }>>`
          SELECT id FROM profiles
          WHERE slug = ${slug} AND is_active = true
          ORDER BY (scope = 'system') DESC, created_at ASC
        `
      : await tx<Array<{ id: string }>>`
          SELECT id FROM profiles
          WHERE slug = ${slug} AND is_active = true
          ORDER BY created_at ASC
        `;
  if (rows.length === 0) return { canonicalId: null, otherCount: 0 };
  return { canonicalId: rows[0].id, otherCount: rows.length - 1 };
}

async function applyDedupeProfileRows(
  tx: Sql,
  op: DedupeProfileRowsOp,
  destructiveTail: boolean
): Promise<OpCounts> {
  const counts: OpCounts = {
    entitiesRepointed: 0,
    facetsRepointed: 0,
    propertyDefsRepointed: 0,
    profilePropertiesRepointed: 0,
    viewsRewritten: 0,
    profilesDeactivated: 0,
  };

  const { canonicalId } = await resolveDedupTarget(
    tx,
    op.slug,
    op.canonical ?? "system"
  );
  if (!canonicalId) return {}; // no active row for the slug — nothing to dedupe.

  // profile_properties first (its property_def_id must still resolve), then
  // property_defs, then entities, then facets, then views. Each collision-skips.
  const pp = await tx`
    UPDATE profile_properties pp
    SET profile_id = ${canonicalId}
    FROM profiles src
    WHERE pp.profile_id = src.id AND src.slug = ${op.slug}
      AND src.is_active = true AND src.id <> ${canonicalId}
      AND NOT EXISTS (
        SELECT 1 FROM profile_properties pp2
        WHERE pp2.profile_id = ${canonicalId}
          AND pp2.property_def_id = pp.property_def_id
      )
  `;
  counts.profilePropertiesRepointed! += pp.count ?? 0;

  const pd = await tx`
    UPDATE property_defs pd
    SET profile_id = ${canonicalId}
    FROM profiles src
    WHERE pd.profile_id = src.id AND src.slug = ${op.slug}
      AND src.is_active = true AND src.id <> ${canonicalId}
      AND NOT EXISTS (
        SELECT 1 FROM property_defs pd2
        WHERE pd2.profile_id = ${canonicalId} AND pd2.slug = pd.slug
          AND pd2.workspace_id IS NOT DISTINCT FROM pd.workspace_id
      )
  `;
  counts.propertyDefsRepointed! += pd.count ?? 0;

  // entities.type already equals the (shared) slug — only the profile_id fk moves.
  const ent = await tx`
    UPDATE entities e
    SET profile_id = ${canonicalId}, updated_at = now()
    FROM profiles src
    WHERE e.profile_id = src.id AND src.slug = ${op.slug}
      AND src.is_active = true AND src.id <> ${canonicalId}
  `;
  counts.entitiesRepointed! += ent.count ?? 0;

  // Facets pointing at a duplicate row (only when the slug is a role) → repoint
  // to canonical, collision-skipping against the live-facet unique index
  // (entity_id, profile_id, COALESCE(context), COALESCE(workspace)). Colliding
  // leftovers stay on the drained row and vanish with its deactivation.
  const fac = await tx`
    UPDATE entity_facets f
    SET profile_id = ${canonicalId}, updated_at = now()
    FROM profiles src
    WHERE f.profile_id = src.id AND src.slug = ${op.slug}
      AND src.is_active = true AND src.id <> ${canonicalId}
      AND f.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM entity_facets f2
        WHERE f2.entity_id = f.entity_id AND f2.profile_id = ${canonicalId}
          AND f2.deleted_at IS NULL
          AND COALESCE(f2.context_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(f.context_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND COALESCE(f2.workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(f.workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
  `;
  counts.facetsRepointed! += fac.count ?? 0;

  const vw = await tx`
    UPDATE views v
    SET scope_profile_ids = array_replace(v.scope_profile_ids, src.id, ${canonicalId})
    FROM profiles src
    WHERE src.slug = ${op.slug} AND src.is_active = true AND src.id <> ${canonicalId}
      AND v.scope_profile_ids @> ARRAY[src.id]
  `;
  counts.viewsRewritten! += vw.count ?? 0;

  if (destructiveTail) {
    const deact = await tx`
      UPDATE profiles
      SET is_active = false, updated_at = now()
      WHERE slug = ${op.slug} AND is_active = true AND id <> ${canonicalId}
    `;
    counts.profilesDeactivated! += deact.count ?? 0;
  }

  return counts;
}

async function applyReconcileEntityScope(
  tx: Sql,
  op: ReconcileEntityScopeOp
): Promise<OpCounts> {
  // Pod→NULL only: an entity on a pod-scope profile that still carries a stamped
  // workspace_id gets it re-nulled. Optional slug narrows to one kind.
  const res = op.slug
    ? await tx`
        UPDATE entities e
        SET workspace_id = NULL, updated_at = now()
        FROM profiles p
        WHERE e.profile_id = p.id AND p.entity_scope = 'pod'
          AND p.slug = ${op.slug}
          AND e.workspace_id IS NOT NULL AND e.deleted_at IS NULL
      `
    : await tx`
        UPDATE entities e
        SET workspace_id = NULL, updated_at = now()
        FROM profiles p
        WHERE e.profile_id = p.id AND p.entity_scope = 'pod'
          AND e.workspace_id IS NOT NULL AND e.deleted_at IS NULL
      `;
  const n = res.count ?? 0;
  return n > 0 ? { entitiesRescoped: n } : {};
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
      // Aggregate across EVERY same-slug source profile row (see
      // applyConvertToFacet) — the facet guard keys off each entity's own
      // profile_id so per-row counts sum correctly.
      const r = await sql<Array<{ n: number }>>`
        SELECT COUNT(*)::int AS n FROM entities e
        JOIN profiles src ON src.id = e.profile_id
          AND src.slug = ${op.slug} AND src.is_active = true
        WHERE e.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM entity_facets f
            WHERE f.entity_id = e.id AND f.profile_id = e.profile_id AND f.deleted_at IS NULL
          )
      `;
      const n = r[0]?.n ?? 0;
      return { entitiesConverted: n, facetsCreated: n };
    }
    case "mergeInto":
      return computeMergeCounts(sql, op, options.destructiveTail);
    case "dedupeProfileRows":
      return computeDedupeCounts(sql, op, options.destructiveTail);
    case "reconcileEntityScope": {
      const r = op.slug
        ? await sql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM entities e
            JOIN profiles p ON p.id = e.profile_id AND p.entity_scope = 'pod'
              AND p.slug = ${op.slug}
            WHERE e.workspace_id IS NOT NULL AND e.deleted_at IS NULL
          `
        : await sql<Array<{ n: number }>>`
            SELECT COUNT(*)::int AS n FROM entities e
            JOIN profiles p ON p.id = e.profile_id AND p.entity_scope = 'pod'
            WHERE e.workspace_id IS NOT NULL AND e.deleted_at IS NULL
          `;
      const n = r[0]?.n ?? 0;
      return n > 0 ? { entitiesRescoped: n } : {};
    }
    case "keep":
    case "extractNonEntity":
      return {};
  }
}

async function computeDedupeCounts(
  sql: Sql,
  op: DedupeProfileRowsOp,
  destructiveTail: boolean
): Promise<OpCounts> {
  const { canonicalId, otherCount } = await resolveDedupTarget(
    sql,
    op.slug,
    op.canonical ?? "system"
  );
  if (!canonicalId || otherCount === 0) return {};

  const counts: OpCounts = {};
  const ent = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM entities e
    JOIN profiles src ON src.id = e.profile_id AND src.slug = ${op.slug}
      AND src.is_active = true AND src.id <> ${canonicalId}
  `;
  if (ent[0]?.n) counts.entitiesRepointed = ent[0].n;

  const fac = await sql<Array<{ n: number }>>`
    SELECT COUNT(*)::int AS n FROM entity_facets f
    JOIN profiles src ON src.id = f.profile_id AND src.slug = ${op.slug}
      AND src.is_active = true AND src.id <> ${canonicalId}
    WHERE f.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM entity_facets f2
        WHERE f2.entity_id = f.entity_id AND f2.profile_id = ${canonicalId}
          AND f2.deleted_at IS NULL
          AND COALESCE(f2.context_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(f.context_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
          AND COALESCE(f2.workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE(f.workspace_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
  `;
  if (fac[0]?.n) counts.facetsRepointed = fac[0].n;

  if (destructiveTail) counts.profilesDeactivated = otherCount;
  return counts;
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
 * Resolve the target KIND profile id for a source row of a given workspace
 * scope. Workspace-aware, mirroring ProfileResolutionService.resolveProfile /
 * ProfileRepository.getBySlugForWorkspace: a workspace-scope target in the
 * SAME workspace wins, then a shared target, then the system/global one. For a
 * system source (workspace_id NULL) no workspace-scope target matches, so it
 * resolves to the system row. Returns null when no active profile carries the
 * slug at all.
 */
async function resolveTargetProfileId(
  sql: Sql,
  slug: string,
  workspaceId: string | null
): Promise<string | null> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM profiles
    WHERE slug = ${slug} AND is_active = true
      AND (
        scope = 'system'
        OR scope = 'shared'
        OR (scope = 'workspace' AND workspace_id IS NOT DISTINCT FROM ${workspaceId})
      )
    ORDER BY CASE
        WHEN scope = 'workspace' AND workspace_id IS NOT DISTINCT FROM ${workspaceId} THEN 0
        WHEN scope = 'shared' THEN 1
        WHEN scope = 'system' THEN 2
        ELSE 3 END,
      created_at ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}
