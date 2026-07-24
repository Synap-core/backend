/**
 * Entity Resolution Service — "impact-aware writes" (SHALLOW / exact-name).
 *
 * Before the AI blindly creates an entity, we look for what already exists in
 * the graph under the SAME name so the create handler can hand the agent
 * feedback: "an entity named '…' already exists as profile X — consider updating
 * it" and "auto-connected to the matching person/company facet". This turns the
 * agent from a blind writer into a gardener.
 *
 * SHALLOW by design (first dogfood iteration):
 *   - EXACT name match, case-insensitive (no fuzzy / semantic match yet), PLUS
 *     an identity fallback: a person's `email` / `discord-handle` (indexed) or
 *     an `aliases[]` entry can also carry the name being resolved, so handles
 *     and nicknames resolve to the existing person instead of a duplicate.
 *   - Same visibility as every other entity read — floors on the entity READ
 *     scope (`accessScopeWhere` +facetLens) so resolution can never surface an
 *     entity the caller couldn't already see.
 *   - Partitioned into:
 *       sameProfile   = the SAME profile + SAME name → likely a duplicate; the
 *                       agent should consider UPDATING instead of re-creating.
 *       otherProfiles = DIFFERENT profile + SAME name → facets of one subject
 *                       (e.g. a `person` and a `company` both named "Acme");
 *                       the create handler auto-connects these.
 *
 * Resolution is ADVISORY: callers MUST treat a thrown error as "no resolution"
 * and never let it block the underlying write.
 */

import { db, resolveIdentity } from "@synap/database";
import { entities } from "@synap/database/schema";
import { accessScopeWhere } from "../utils/project-scope.js";

/** Minimal entity shape the resolver returns (ids + names + profile). */
export interface ResolvedEntity {
  id: string;
  /** Entity name === the `title` column. */
  name: string;
  /** profile slug (the `type` column on the entities table). */
  profileSlug: string;
  workspaceId: string | null;
}

/** Result of an exact-name resolution. */
export interface EntityResolution {
  /** SAME profile + SAME name → likely a duplicate the agent should update. */
  sameProfile: ResolvedEntity | null;
  /** DIFFERENT profile + SAME name → facets of one subject; auto-connect targets. */
  otherProfiles: ResolvedEntity[];
}

/** Raw row shape needed by the pure partitioner (subset of the entities row). */
export interface ResolutionCandidateRow {
  id: string;
  title: string | null;
  type: string;
  workspaceId: string | null;
}

/**
 * PURE: split exact-name candidate rows into same-profile vs other-profile,
 * excluding the just-created entity itself (`excludeId`).
 *
 * Exported standalone so the partition rule is unit-testable without a live DB.
 * The DB query (the I/O shell) lives in `resolveEntityByName` below.
 */
export function partitionResolutionMatches(
  rows: ResolutionCandidateRow[],
  targetProfileSlug: string,
  excludeId?: string
): EntityResolution {
  let sameProfile: ResolvedEntity | null = null;
  const otherProfiles: ResolvedEntity[] = [];

  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    const resolved: ResolvedEntity = {
      id: row.id,
      name: row.title ?? "",
      profileSlug: row.type,
      workspaceId: row.workspaceId,
    };
    if (row.type === targetProfileSlug) {
      // Keep the FIRST same-profile match (callers only need one "duplicate?" hint).
      if (!sameProfile) sameProfile = resolved;
    } else {
      otherProfiles.push(resolved);
    }
  }

  return { sameProfile, otherProfiles };
}

/**
 * Resolve EXACT-name matches (case-insensitive) for a would-be / just-created
 * entity, within the caller's user-visible scope.
 *
 * @param name            The entity name to match (=== title). Empty/blank → no match.
 * @param targetProfileSlug The profile the new entity belongs to (for partitioning).
 * @param userId          The acting user — scopes the read via the entity READ floor.
 * @param excludeId       Optional id to exclude (the just-created entity itself).
 *
 * Throwing is the caller's signal to omit resolution; callers wrap in try/catch.
 */
export async function resolveEntityByName(params: {
  name: string;
  targetProfileSlug: string;
  userId: string;
  excludeId?: string;
  /** Cap on candidate rows scanned (defensive). */
  limit?: number;
}): Promise<EntityResolution> {
  const name = params.name?.trim();
  if (!name) return { sameProfile: null, otherProfiles: [] };

  // Thin wrapper over the ONE identity resolver. This is purely WEAK resolution
  // (name / indexed discord-handle / alias) — no strong signals are passed, so
  // `email` never auto-resolves here (facet detection stays name-based). The
  // SSOT returns ALL cross-kind weak candidates; we partition them into
  // same-profile (likely dup) vs other-profile (facets to auto-connect).
  const { candidates } = await resolveIdentity(db, {
    userId: params.userId,
    name,
    // The weak candidate search returns entity title/type to the caller for
    // facet auto-connect and is NOT re-gated downstream — so it must floor on
    // the entity READ visibility (owner-gated NULL + membership + exposure +
    // role-lens), NOT bare `userVisibleWhere` which admits pod-wide NULL rows to
    // ALL users. Matches entities.list.
    userScope: accessScopeWhere({
      workspaceIdColumn: entities.workspaceId,
      entityIdColumn: entities.id,
      ownerColumn: entities.userId,
      userId: params.userId,
      facetLens: true,
    }),
    limit: params.limit ?? 25,
  });

  return partitionResolutionMatches(
    candidates.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      workspaceId: c.workspaceId,
    })),
    params.targetProfileSlug,
    params.excludeId
  );
}
