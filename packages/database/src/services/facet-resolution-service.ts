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
import { and, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type * as schema from "../schema/index.js";
import type { Profile } from "../schema/profiles.js";
import { profiles } from "../schema/profiles.js";
import { entities } from "../schema/entities.js";
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
 * Batch-load live facet (role-profile) slugs for a set of entity ids → a
 * Map<entityId, slug[]>. One query for the whole batch. UNFILTERED lens — this
 * is the raw entity→facet-slug join used by indexing (per-entity search docs)
 * and the object-graph subtype hydrator; caller-side visibility is enforced
 * elsewhere. Entities with no live facet are simply absent from the map.
 *
 * The ONE implementation of this join — previously hand-rolled byte-identically
 * in @synap/search's indexing-service and @synap/api's graph-service.
 */
export async function loadFacetSlugsBatch(
  db: PostgresJsDatabase<typeof schema>,
  entityIds: string[]
): Promise<Map<string, string[]>> {
  if (entityIds.length === 0) return new Map();
  const rows = await db
    .select({ entityId: entityFacets.entityId, slug: profiles.slug })
    .from(entityFacets)
    .innerJoin(profiles, eq(entityFacets.profileId, profiles.id))
    .where(
      and(
        inArray(entityFacets.entityId, entityIds),
        isNull(entityFacets.deletedAt)
      )
    );

  const out = new Map<string, string[]>();
  for (const row of rows) {
    const list = out.get(row.entityId);
    if (list) list.push(row.slug);
    else out.set(row.entityId, [row.slug]);
  }
  return out;
}

/**
 * The ONE facet-EXISTS predicate over the OUTER `entities` row: true when the
 * entity carries a live facet whose role-profile is in `roleProfileIds`,
 * visible under the given lens (`facetVisibilityConditions`). Correlates on
 * `entities.id`, so it must be composed into a query that selects from the
 * `entities` schema table.
 *
 * This is the single source for the entity→role-facet scope test — both
 * `entities.list` (its `facetSlug` filter AND its polymorphic `profileSlug`
 * routing) and `views.execute` (the role branch of `scopeProfileIds`) go
 * through here so the EXISTS is never hand-rolled twice (see also
 * `profileScopeConditions`).
 */
export function facetRoleExists(
  db: PostgresJsDatabase<typeof schema>,
  roleProfileIds: string[],
  opts: { userId: string; workspaceId?: string | null }
): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(entityFacets)
      .where(
        and(
          eq(entityFacets.entityId, entities.id),
          inArray(entityFacets.profileId, roleProfileIds),
          isNull(entityFacets.deletedAt),
          ...facetVisibilityConditions(opts)
        )
      )
  );
}

/**
 * Polymorphic profile-scope predicate for a set of profiles pre-tagged with
 * their `profileKind`. A view/list scoped by profile id is kind-blind, but a
 * profile can be either the entity's primary `kind` (matched via
 * `entities.profileId`) or an attachable `role`/facet (matched via
 * `facetRoleExists`). `convertToFacet` flips `profile_kind` in place — same
 * profile id — and repoints + facets the entities, so the SAME scope id must
 * resolve to the SAME entity set whether the profile is currently a kind or a
 * role. This OR-composes the two branches per the caller's mix.
 *
 * Returns `undefined` for an empty input (no scope) — callers decide whether
 * that means "match nothing" (a scoped read that resolved to zero profiles) or
 * "no filter".
 */
export function profileScopeConditions(
  db: PostgresJsDatabase<typeof schema>,
  profileRows: Array<{ id: string; profileKind: "kind" | "role" }>,
  opts: { userId: string; workspaceId?: string | null }
): SQL | undefined {
  const kindIds = profileRows
    .filter((p) => p.profileKind !== "role")
    .map((p) => p.id);
  const roleIds = profileRows
    .filter((p) => p.profileKind === "role")
    .map((p) => p.id);

  const branches: SQL[] = [];
  if (kindIds.length > 0) branches.push(inArray(entities.profileId, kindIds));
  if (roleIds.length > 0) branches.push(facetRoleExists(db, roleIds, opts));

  if (branches.length === 0) return undefined;
  if (branches.length === 1) return branches[0];
  return or(...branches) as SQL;
}

/**
 * Polymorphic single-slug scope predicate: resolve `profileSlug`'s
 * `profileKind` and return the matching entity condition — role → the
 * facet-EXISTS (`facetRoleExists`), kind/unknown → `entities.type` equality
 * (byte-for-byte the pre-facets behavior, so unconverted and never-converted
 * slugs are unaffected). This is the drop-in for every read that takes ONE
 * caller-supplied profileSlug (search, graph filters, builtin `entity.query`,
 * pod-personal lists); multi-id scopes go through `profileScopeConditions`.
 *
 * `opts.workspaceId` lens: undefined = facets across all workspaces;
 * null = pod-wide facets only; string = that workspace + pod-wide — always
 * with the owner floor (see `facetVisibilityConditions`).
 */
export async function profileSlugScopeCondition(
  db: PostgresJsDatabase<typeof schema>,
  profileSlug: string,
  opts: { userId: string; workspaceId?: string | null }
): Promise<SQL> {
  const row = await db.query.profiles.findFirst({
    where: eq(profiles.slug, profileSlug),
    columns: { id: true, profileKind: true },
  });
  if (row?.profileKind === "role") {
    return facetRoleExists(db, [row.id], opts);
  }
  return eq(entities.type, profileSlug);
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
