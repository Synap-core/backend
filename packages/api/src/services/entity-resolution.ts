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
 *   - EXACT name match only, case-insensitive (no fuzzy / semantic match yet).
 *   - Same user-visible scope as every other read — reuses `userVisibleWhere`
 *     so resolution can never surface an entity the caller couldn't already see.
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

import { and, ilike, isNull } from "@synap/database";
import { db } from "@synap/database";
import { entities } from "@synap/database/schema";
import { userVisibleWhere } from "../utils/user-visible-where.js";

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
 * @param userId          The acting user — scopes the read via `userVisibleWhere`.
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

  // EXACT name, case-insensitive. `ilike` with no wildcards is an exact CI match;
  // escape LIKE metacharacters so a name containing % or _ matches literally.
  const escaped = name.replace(/([%_\\])/g, "\\$1");

  const rows = await db.query.entities.findMany({
    where: and(
      isNull(entities.deletedAt),
      ilike(entities.title, escaped),
      userVisibleWhere(entities.workspaceId, params.userId)
    ),
    columns: {
      id: true,
      title: true,
      type: true,
      workspaceId: true,
    },
    limit: params.limit ?? 25,
  });

  return partitionResolutionMatches(
    rows as ResolutionCandidateRow[],
    params.targetProfileSlug,
    params.excludeId
  );
}
