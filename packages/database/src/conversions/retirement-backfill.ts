/**
 * RETIREMENT-TOMBSTONE BACKFILL for rows an already-LEDGERED destructive tail
 * deactivated without one.
 *
 * Until 2026-09-14 the destructive tails of `mergeInto` / `dedupeProfileRows`
 * deactivated drained rows with a bare `is_active = false`. resolveProfileForApply
 * revives an inactive row that carries no `ui_hints.retired` tombstone, so the
 * boot template reconcile could put a merged-away workspace seat back. Tails now
 * stamp the tombstone themselves (engine.ts `retireDrainedProfiles`), but a
 * ledgered op is SKIPPED by every later run — its drained rows can only be
 * reached from here.
 *
 * Scope, per op in the given manifest that is ledgered (applied, `error IS NULL`,
 * not a dry run) and is `mergeInto` or `dedupeProfileRows`:
 *   - mergeInto, cross-scope (`intoScope` set): INACTIVE rows of `fromSlugs` →
 *     the ONE active pod-wide `intoSlug` row at `intoScope`;
 *   - mergeInto, same-scope: each INACTIVE `fromSlugs` row → the earliest active
 *     `intoSlug` row at its own scope + workspace (engine.ts
 *     `sameScopeCanonicalPairs`, the rule the tail itself uses);
 *   - dedupeProfileRows: INACTIVE rows of `slug` → the canonical the op resolves
 *     (engine.ts `resolveDedupTarget`; the canonical is active, so never itself).
 * Each is stamped `{ at, reason: "conversion:<opKey>", mergedInto }`.
 *
 * Invariants: never touches an ACTIVE row; never overwrites an existing
 * tombstone (so a second call stamps 0); never tombstones a row whose canonical
 * does not resolve — those ids are REPORTED in `unresolvedProfileIds` instead.
 * Dry run: counts only, no write.
 *
 * Attribution is by slug, not by timestamp: an inactive row of a merged-away
 * slug that was deactivated for another reason before the op (e.g. a pre-A0
 * soft delete) is stamped too. For a ledgered merge/dedupe that is the intent —
 * reviving such a row is exactly what the op retired — but it is a known
 * over-approximation.
 *
 * The UPDATE lives in engine.ts (`tombstoneInactiveProfiles`): the api
 * `project-is-not-an-entity-profile` tripwire admits raw `profiles` writes from
 * that file only. The resulting import cycle (engine ↔ this file) is between
 * function declarations used at call time only — nothing is read at module
 * evaluation.
 */

import type { Sql } from "postgres";
import type { ConversionManifest } from "./manifest.js";
import {
  conversionRetirement,
  ensureConversionsLedger,
  resolveDedupTarget,
  resolveScopedCanonicalId,
  sameScopeCanonicalPairs,
  tombstoneInactiveProfiles,
} from "./engine.js";

export interface RetirementBackfillOpResult {
  opKey: string;
  op: "mergeInto" | "dedupeProfileRows";
  /** Rows that resolve a canonical and would be / were stamped. */
  eligible: number;
  /** Rows actually stamped (0 in a dry run). */
  stamped: number;
  /** Inactive, un-tombstoned rows whose canonical does not resolve — left untouched. */
  unresolvedProfileIds: string[];
}

export interface RetirementBackfillResult {
  dryRun: boolean;
  eligible: number;
  stamped: number;
  unresolved: number;
  ops: RetirementBackfillOpResult[];
}

/** Inactive rows of these slugs that carry no tombstone readProfileRetirement would see. */
async function untombstonedInactiveIds(
  sql: Sql,
  slugs: string[]
): Promise<string[]> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM profiles
    WHERE slug = ANY(${slugs}::text[]) AND is_active = false
      AND coalesce(jsonb_typeof(coalesce(ui_hints, '{}'::jsonb) -> 'retired'), 'null') NOT IN ('object', 'array')
    ORDER BY id
  `;
  return rows.map((r) => r.id);
}

export async function backfillConversionRetirements(
  sql: Sql,
  manifest: ConversionManifest,
  options: { dryRun: boolean }
): Promise<RetirementBackfillResult> {
  await ensureConversionsLedger(sql);
  const ledgerRows = await sql<Array<{ op_key: string }>>`
    SELECT op_key FROM "_conversions" WHERE error IS NULL AND dry_run = false
  `;
  const ledgered = new Set(ledgerRows.map((r) => r.op_key));
  const at = new Date();
  const ops: RetirementBackfillOpResult[] = [];

  for (const op of manifest.ops) {
    if (op.op !== "mergeInto" && op.op !== "dedupeProfileRows") continue;
    if (!ledgered.has(op.opKey)) continue;

    const groups = new Map<string, string[]>();
    const unresolved: string[] = [];

    if (op.op === "dedupeProfileRows") {
      const candidates = await untombstonedInactiveIds(sql, [op.slug]);
      const { canonicalId } = await resolveDedupTarget(
        sql,
        op.slug,
        op.canonical ?? "system"
      );
      if (canonicalId) groups.set(canonicalId, candidates);
      else unresolved.push(...candidates);
    } else if (op.intoScope !== undefined) {
      const candidates = await untombstonedInactiveIds(sql, op.fromSlugs);
      const canonicalId = await resolveScopedCanonicalId(
        sql,
        op.intoSlug,
        op.intoScope
      );
      if (canonicalId) groups.set(canonicalId, candidates);
      else unresolved.push(...candidates);
    } else {
      for (const from of op.fromSlugs) {
        const candidates = new Set(await untombstonedInactiveIds(sql, [from]));
        const pairs = await sameScopeCanonicalPairs(
          sql,
          op.intoSlug,
          from,
          false
        );
        for (const p of pairs) {
          if (!candidates.has(p.id)) continue; // already tombstoned
          groups.set(p.k_id, [...(groups.get(p.k_id) ?? []), p.id]);
          candidates.delete(p.id);
        }
        unresolved.push(...candidates);
      }
    }

    let eligible = 0;
    let stamped = 0;
    for (const [canonicalId, ids] of groups) {
      eligible += ids.length;
      if (!options.dryRun) {
        stamped += await tombstoneInactiveProfiles(
          sql,
          ids,
          conversionRetirement(op.opKey, canonicalId, at)
        );
      }
    }
    ops.push({
      opKey: op.opKey,
      op: op.op,
      eligible,
      stamped,
      unresolvedProfileIds: unresolved,
    });
  }

  return {
    dryRun: options.dryRun,
    eligible: ops.reduce((n, o) => n + o.eligible, 0),
    stamped: ops.reduce((n, o) => n + o.stamped, 0),
    unresolved: ops.reduce((n, o) => n + o.unresolvedProfileIds.length, 0),
    ops,
  };
}
