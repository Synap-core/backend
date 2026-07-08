/**
 * Facet Resolution Service — Kind + Facets
 *
 * Sister to `ProfileResolutionService.getEffectiveProperties`: resolves an
 * entity's live facets joined with their role-profile and that profile's
 * effective properties (through the same workspace lens).
 *
 * Kept as its own module (rather than folded into ProfileResolutionService)
 * so this read-only resolver doesn't need an EventRepository — it queries
 * entity_facets directly rather than going through FacetRepository (whose
 * write paths are the one door for INSERT, but reads don't need that door).
 * Visibility semantics are shared with FacetRepository via
 * `facetVisibilityConditions` — the compile-time single source.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type * as schema from "../schema/index.js";
import type { Profile } from "../schema/profiles.js";
import { profiles } from "../schema/profiles.js";
import { entityFacets, type EntityFacet } from "../schema/entity-facets.js";
import { facetVisibilityConditions } from "../utils/facet-visibility.js";
import {
  ProfileResolutionService,
  type EffectiveProperty,
} from "./profile-resolution-service.js";

export interface EffectiveFacet {
  facet: EntityFacet;
  profile: Profile;
  effectiveProperties: EffectiveProperty[];
}

/**
 * Resolve every live facet attached to an entity, each joined with its
 * role-profile and that profile's effective properties (workspace-lensed).
 *
 * `opts.workspaceId`: undefined = all workspaces; null = pod-wide facets
 * only; string = that workspace's facets plus pod-wide facets. Pod-wide
 * facets carry an owner floor (`opts.userId`) — mirrors
 * `FacetRepository.getByEntity` via the shared predicate.
 */
export async function getEffectiveFacets(
  db: PostgresJsDatabase<typeof schema>,
  entityId: string,
  opts: { userId: string; workspaceId?: string | null }
): Promise<EffectiveFacet[]> {
  const profileResolution = new ProfileResolutionService(db);
  const { workspaceId } = opts;

  const conditions: SQL[] = [
    eq(entityFacets.entityId, entityId),
    isNull(entityFacets.deletedAt),
    ...facetVisibilityConditions(opts),
  ];

  const facets = await db.query.entityFacets.findMany({
    where: and(...conditions),
  });
  if (facets.length === 0) return [];

  const profileIds = [...new Set(facets.map((f) => f.profileId))];
  const profileRows = await db.query.profiles.findMany({
    where: inArray(profiles.id, profileIds),
  });
  const profileById = new Map(profileRows.map((p) => [p.id, p]));

  const results: EffectiveFacet[] = [];
  for (const facet of facets) {
    const profile = profileById.get(facet.profileId);
    if (!profile) continue; // orphaned facet (profile deleted) — skip
    const effectiveProperties = await profileResolution.getEffectiveProperties(
      profile.id,
      workspaceId
    );
    results.push({ facet, profile, effectiveProperties });
  }
  return results;
}
