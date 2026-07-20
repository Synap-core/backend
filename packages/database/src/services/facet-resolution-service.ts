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
import {
  and,
  eq,
  exists,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
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

export interface FacetVisibilityScope {
  userId: string;
  workspaceId?: string | null;
  /** Required for identity-wide/no-lens reads to enforce the caller's floor. */
  allowedWorkspaceIds?: string[];
}

/**
 * Batch-load live facet (role-profile) slugs for a set of entity ids → a
 * Map<entityId, slug[]>. One query for the whole batch. Every user-facing call
 * must supply a visibility scope; the only unfiltered wrapper is named for the
 * trusted indexing job below. Entities with no live facet are absent.
 *
 * The ONE implementation of this join — previously hand-rolled byte-identically
 * in @synap/search's indexing-service and @synap/api's graph-service.
 */
async function loadFacetSlugsBatchInternal(
  db: PostgresJsDatabase<typeof schema>,
  entityIds: string[],
  visibility?: FacetVisibilityScope
): Promise<Map<string, string[]>> {
  if (entityIds.length === 0) return new Map();
  const rows = await db
    .select({ entityId: entityFacets.entityId, slug: profiles.slug })
    .from(entityFacets)
    .innerJoin(profiles, eq(entityFacets.profileId, profiles.id))
    .where(
      and(
        inArray(entityFacets.entityId, entityIds),
        isNull(entityFacets.deletedAt),
        ...(visibility ? facetVisibilityConditions(visibility) : [])
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
 * User-facing batch annotation. The caller must provide either a verified
 * explicit workspace lens or `allowedWorkspaceIds` for an identity-wide read.
 */
export async function loadFacetSlugsBatch(
  db: PostgresJsDatabase<typeof schema>,
  entityIds: string[],
  visibility: FacetVisibilityScope
): Promise<Map<string, string[]>> {
  return loadFacetSlugsBatchInternal(db, entityIds, visibility);
}

/**
 * One live facet row in the RICH batch shape: the slug plus the overlay the
 * slug alone cannot carry (`properties`, `status`). Sibling of the slugs-only
 * annotation — same join, same lens, wider projection.
 */
export interface FacetRowAnnotation {
  facetId: string;
  slug: string;
  properties: Record<string, unknown>;
  status: string | null;
}

/**
 * Batch-load live facet ROWS for a set of entity ids → a
 * Map<entityId, FacetRowAnnotation[]>. The rich sibling of
 * {@link loadFacetSlugsBatch}: ONE query for the whole page (never N+1), the
 * SAME join and the SAME `facetVisibilityConditions` lens — only the projection
 * widens to carry each facet's overlay `properties` and `status`.
 *
 * Exists because the slugs-only annotation is lossy for any consumer that must
 * READ a facet overlay on a list page (e.g. the CRM's `leadStage: "prospect"`,
 * which distinguishes a Prospect from a plain Lead). Opt-in only — the default
 * list shape stays the cheap slug annotation its consumers depend on.
 *
 * Every call must supply a visibility scope; there is deliberately no
 * unfiltered wrapper for this shape.
 */
export async function loadFacetRowsBatch(
  db: PostgresJsDatabase<typeof schema>,
  entityIds: string[],
  visibility: FacetVisibilityScope
): Promise<Map<string, FacetRowAnnotation[]>> {
  if (entityIds.length === 0) return new Map();
  const rows = await db
    .select({
      entityId: entityFacets.entityId,
      facetId: entityFacets.id,
      slug: profiles.slug,
      properties: entityFacets.properties,
      status: entityFacets.status,
    })
    .from(entityFacets)
    .innerJoin(profiles, eq(entityFacets.profileId, profiles.id))
    .where(
      and(
        inArray(entityFacets.entityId, entityIds),
        isNull(entityFacets.deletedAt),
        ...facetVisibilityConditions(visibility)
      )
    );

  const out = new Map<string, FacetRowAnnotation[]>();
  for (const row of rows) {
    const annotation: FacetRowAnnotation = {
      facetId: row.facetId,
      slug: row.slug,
      properties: (row.properties ?? {}) as Record<string, unknown>,
      status: row.status,
    };
    const list = out.get(row.entityId);
    if (list) list.push(annotation);
    else out.set(row.entityId, [annotation]);
  }
  return out;
}

/**
 * TRUSTED INDEXING ONLY. Search documents are stored with all role slugs and
 * query-time access control applies the user floor. Never use this in an API
 * response, user-facing filter, graph, relation, or retrieval path.
 */
export async function loadAllFacetSlugsBatchForTrustedIndexing(
  db: PostgresJsDatabase<typeof schema>,
  entityIds: string[]
): Promise<Map<string, string[]>> {
  return loadFacetSlugsBatchInternal(db, entityIds);
}

/**
 * Slug → kind/role classification for the RECALL layer (search/retrieval).
 * A recall half filters on a text engine (Typesense `entityType`/`facetSlugs`)
 * or `entity_vectors.entityType` — neither can run the SQL `facetRoleExists`
 * EXISTS that `profileSlugScopeCondition` uses over `entities`. So the recall
 * layer needs the SAME kind-vs-role verdict as a plain boolean pair, then it
 * routes: kind → match `entityType`, role → match facet membership (by slug).
 * Same source-of-truth logic as `profileSlugScopeCondition` (a slug can carry
 * both a system kind row and a role twin), reduced to booleans.
 */
export interface SlugKindInfo {
  /** Slug has ≥1 primary-kind row → an `entityType`/`entities.type` match applies. */
  hasKindRow: boolean;
  /** Slug has ≥1 role row → facet-membership (by slug) match applies. */
  hasRoleRow: boolean;
}

/** TTL cache (60s) mirroring `ProfileResolutionService.getEntityScope` — the
 * recall layer resolves the same handful of inferred slugs on every query. */
const slugKindCache = new Map<
  string,
  { info: SlugKindInfo; expiresAt: number }
>();
const SLUG_KIND_TTL_MS = 60_000;

/**
 * Classify a profile slug as kind and/or role for the recall layer. Unknown
 * slugs (no profile row) resolve to `{ hasKindRow: true, hasRoleRow: false }`
 * so recall stays byte-for-byte the pre-facets `entityType` match. Cached 60s.
 */
export async function resolveSlugKind(
  db: PostgresJsDatabase<typeof schema>,
  slug: string
): Promise<SlugKindInfo> {
  const cached = slugKindCache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const rows = await db.query.profiles.findMany({
    where: eq(profiles.slug, slug),
    columns: { profileKind: true },
  });
  const info: SlugKindInfo = {
    hasKindRow: rows.length === 0 || rows.some((r) => r.profileKind !== "role"),
    hasRoleRow: rows.some((r) => r.profileKind === "role"),
  };
  slugKindCache.set(slug, { info, expiresAt: Date.now() + SLUG_KIND_TTL_MS });
  return info;
}

export interface RolePayloadInfo {
  profileId: string;
  slug: string;
  /** Kinds this role may attach to; empty = applies to any kind. */
  applicableKinds: string[];
}

/**
 * Kind + Facets guard — the ONE check for "is this create-payload slug actually
 * a ROLE?". A caller (importer/agent) that tries to CREATE an entity whose
 * `profileSlug` is a role-profile (client/partner/investor/…) must NOT get a
 * role-named entity: the role is a facet on a real subject. Returns the role's
 * profileId + applicableKinds when `slug` resolves to a role profile, else null
 * (it's a primary kind, or unknown — create it normally). Best-effort read;
 * matches on slug (findFirst) — roles are user/system-scoped, not per-workspace.
 */
export async function resolveRolePayload(
  db: PostgresJsDatabase<typeof schema>,
  slug: string
): Promise<RolePayloadInfo | null> {
  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.slug, slug),
    columns: { id: true, slug: true, profileKind: true, applicableKinds: true },
  });
  if (!profile || profile.profileKind !== "role") return null;
  return {
    profileId: profile.id,
    slug: profile.slug,
    applicableKinds: profile.applicableKinds ?? [],
  };
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
  opts: FacetVisibilityScope
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
  opts: FacetVisibilityScope
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
 * THE slug → profile-rows lookup. Every read that routes a caller-supplied
 * `profileSlug` (the scope predicate below, `entities.list`'s descendant-aware
 * branch, the `facetSlug` filter, `groupByFacetStatus`) resolves it through
 * here, so "what rows does this slug name?" has exactly one answer.
 *
 * ALL rows for the slug, not `findFirst`: one slug can be carried by several
 * profile rows (e.g. a system row + a workspace-scope twin — the perso pod's
 * two `knowledge` rows). The legacy `entities.type` match was text-based and
 * therefore row-blind; the facet EXISTS is id-based, so it must OR every role
 * row's id or entities faceted on the twin silently vanish (verified live
 * post-conversion).
 *
 * DELIBERATELY UNSCOPED by user/workspace: this answers "does this pod's
 * vocabulary contain this slug at all", not "may this caller see it". Access is
 * enforced by the entity floor the predicate is ANDed with, never here. An
 * EMPTY result therefore means the slug names nothing anywhere in the pod —
 * see `assertKnownProfileSlug` (API layer), the one door that turns that into
 * an error instead of a silently-empty list.
 */
export async function profileSlugRows(
  db: PostgresJsDatabase<typeof schema>,
  profileSlug: string
): Promise<Array<{ id: string; profileKind: "kind" | "role" }>> {
  return db.query.profiles.findMany({
    where: eq(profiles.slug, profileSlug),
    columns: { id: true, profileKind: true },
  });
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
 *
 * Callers that ALREADY hold the slug's rows (every API door now resolves them
 * once through `assertKnownProfileSlug`) must call
 * `profileSlugScopeConditionFromRows` instead — this overload exists only for
 * callers that do not, and it is a thin `profileSlugRows` + delegate so the
 * branch logic has exactly one implementation.
 */
export async function profileSlugScopeCondition(
  db: PostgresJsDatabase<typeof schema>,
  profileSlug: string,
  opts: FacetVisibilityScope
): Promise<SQL> {
  const rows = await profileSlugRows(db, profileSlug);
  return profileSlugScopeConditionFromRows(db, profileSlug, rows, opts);
}

/**
 * THE implementation of the single-slug scope predicate — see
 * `profileSlugScopeCondition` for the semantics; this is the same function with
 * the `profileSlugRows` lookup lifted out.
 *
 * WHY IT EXISTS. `assertKnownProfileSlug` (API layer) already runs the ONE
 * `profiles WHERE slug = ?` lookup and RETURNS the rows, as its doc promises.
 * A caller that then called the slug-taking overload re-ran the identical query
 * a second time per read. Taking the rows keeps that promise true at every door.
 *
 * `profileSlug` is still required: the kind branch is the byte-for-byte
 * pre-facets TEXT match on `entities.type`, which is row-blind by design (see
 * `profileSlugRows`) — it matches the slug, not an id.
 *
 * The zero-row fallback (`hasKindRow` when `rows` is empty → `entities.type`
 * equality) is DELIBERATE and preserved: doors that fail closed on an unknown
 * slug do so before calling here, and internal callers with no caller-supplied
 * slug keep the legacy text behavior.
 */
export function profileSlugScopeConditionFromRows(
  db: PostgresJsDatabase<typeof schema>,
  profileSlug: string,
  rows: Array<{ id: string; profileKind: "kind" | "role" }>,
  opts: FacetVisibilityScope
): SQL {
  const roleIds = rows.filter((r) => r.profileKind === "role").map((r) => r.id);
  const hasKindRow =
    rows.length === 0 || rows.some((r) => r.profileKind !== "role");

  const branches: SQL[] = [];
  // Kind branch stays the byte-for-byte pre-facets text match (row-blind).
  if (hasKindRow) branches.push(eq(entities.type, profileSlug) as SQL);
  if (roleIds.length > 0) branches.push(facetRoleExists(db, roleIds, opts));

  if (branches.length === 1) return branches[0];
  return or(...branches) as SQL;
}

/**
 * Resolve every live facet attached to an entity, each joined with its
 * role-profile and that profile's effective properties.
 *
 * `opts.workspaceId`: undefined = all workspaces; null = pod-wide facets
 * only; string = that workspace's facets plus pod-wide facets. Pod-wide
 * facets carry an owner floor (`opts.userId`) — mirrors
 * `FacetRepository.getByEntity` via the shared predicate. On the unfiltered
 * identity path, each role resolves properties through its own attachment
 * workspace so one role never borrows another workspace's overlays.
 */
export async function getEffectiveFacets(
  db: PostgresJsDatabase<typeof schema>,
  entityId: string,
  opts: FacetVisibilityScope
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

  const resolved = await Promise.all(
    facets.map(async (facet): Promise<EffectiveFacet | null> => {
      const profile = profileById.get(facet.profileId);
      if (!profile) return null; // orphaned facet (profile deleted) — skip
      const propertyWorkspaceId =
        workspaceId === undefined ? (facet.workspaceId ?? null) : workspaceId;
      const effectiveProperties =
        await profileResolution.getEffectiveProperties(
          profile.id,
          propertyWorkspaceId
        );
      return { facet, profile, effectiveProperties };
    })
  );

  return resolved.filter((item): item is EffectiveFacet => item !== null);
}
