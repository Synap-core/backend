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

import { and, ilike, isNull, or, inArray, drizzleSql } from "@synap/database";
import { db } from "@synap/database";
import {
  entities,
  propertyDefs,
  entityPropertyIndex,
} from "@synap/database/schema";
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
  const lowerName = name.toLowerCase();

  // IDENTITY FALLBACK: a person's `email`/`discord-handle` (indexed in
  // entity_property_index) or an `aliases[]` entry (source JSONB) can carry the
  // name we're resolving — so "0scr" / "oscar@x.com" resolves to the existing
  // "Oscar Piveteau" person instead of spawning a duplicate. Base defs are
  // global (profile_id/workspace_id NULL); if unseeded the list is empty and we
  // silently fall back to title-only matching.
  // `email` is intentionally NOT an auto-resolution signal — shared/generic
  // inboxes (support@, hello@) would wrongly resolve two different people to one.
  // `discord-handle` is near-unique; aliases (below) carry same-person forms.
  const identityDefs = await db.query.propertyDefs.findMany({
    where: and(
      inArray(propertyDefs.slug, ["discord-handle"]),
      isNull(propertyDefs.profileId),
      isNull(propertyDefs.workspaceId)
    ),
    columns: { id: true },
  });
  const identityDefIds = identityDefs.map((d) => d.id);

  // Entities whose indexed discord-handle equals the name (case-folded).
  let identityEntityIds: string[] = [];
  if (identityDefIds.length > 0) {
    const idxRows = await db.query.entityPropertyIndex.findMany({
      where: and(
        inArray(entityPropertyIndex.propertyDefId, identityDefIds),
        drizzleSql`lower(${entityPropertyIndex.valueText}) = ${lowerName}`
      ),
      columns: { entityId: true },
      limit: params.limit ?? 25,
    });
    identityEntityIds = idxRows.map((r) => r.entityId);
  }

  // Match on title OR indexed handle OR an alias (JSONB containment, case-folded
  // on the source `properties.aliases`). The CASE guard keeps
  // jsonb_array_elements_text from erroring on a non-array `aliases` value.
  const matchClauses = [ilike(entities.title, escaped)];
  if (identityEntityIds.length > 0) {
    matchClauses.push(inArray(entities.id, identityEntityIds));
  }
  matchClauses.push(
    drizzleSql`EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(${entities.properties} -> 'aliases') = 'array'
             THEN ${entities.properties} -> 'aliases'
             ELSE '[]'::jsonb END
      ) AS alias
      WHERE lower(alias) = ${lowerName}
    )`
  );

  const rows = await db.query.entities.findMany({
    where: and(
      isNull(entities.deletedAt),
      or(...matchClauses),
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
