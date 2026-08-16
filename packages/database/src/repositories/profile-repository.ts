/**
 * Profile Repository
 *
 * Handles CRUD operations for profiles (entity types).
 */

import { eq, and, or, sql, isNotNull, inArray } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import {
  memberWorkspaceIds as memberWorkspaceIdsQuery,
  ownedWorkspaceIds as ownedWorkspaceIdsQuery,
  podVisibleWorkspaceIds as podVisibleWorkspaceIdsQuery,
} from "../utils/user-visible-where.js";
import { assertProfileSlugNotReserved } from "../utils/reserved-profile-slugs.js";
import {
  profiles,
  profileWorkspaceAccess,
  type Profile,
  type NewProfile,
  type AiPosture,
  ProfileScope,
} from "../schema/profiles.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export interface CreateProfileInput {
  id?: string;
  slug: string;
  displayName: string;
  parentProfileId?: string;
  uiHints?: Record<string, unknown>;
  /** Default property values applied when creating a new entity of this type. */
  defaultValues?: Record<string, unknown>;
  scope?: ProfileScope;
  /**
   * Whether entities of this profile are pod-wide or workspace-scoped.
   *
   * OMIT to get the doctrine default resolved from `profileKind`:
   *   - `profileKind: 'kind'` (or omitted) ⇒ `"pod"`
   *   - `profileKind: 'role'`              ⇒ `"workspace"`
   *
   * Pass a value only to deviate — a workspace-scoped KIND (Deal, Pipeline,
   * devplane types) is legitimate but must now be explicit. `'pod'` on a role
   * is a contradiction and throws.
   */
  entityScope?: "pod" | "workspace";
  userId?: string;
  workspaceId?: string;
  /**
   * Semantic identity for cross-workspace queries. Defaults to `slug`.
   * Pass `null` to explicitly mark this profile as private (no cross-workspace semantics).
   */
  semanticSlug?: string | null;
  /**
   * System-default renderer for the LIST slot (Profile Renderer North Star).
   * Stored as JSONB. Shape: RendererTarget from @synap-core/renderer-runtime.
   * NULL means "use the hardcoded system fallback".
   */
  defaultListRenderer?: Record<string, unknown> | null;
  /**
   * System-default renderer for the DETAIL slot.
   */
  defaultDetailRenderer?: Record<string, unknown> | null;
  /**
   * System-default renderer for the DASHBOARD slot (per-profile bento).
   */
  defaultDashboardRenderer?: Record<string, unknown> | null;
  /**
   * The profile's renderers keyed by ContentKind (entity-detail /
   * entity-profile / collection) — the canonical map that replaces the old
   * list/detail/dashboard "slots". Source of truth for `getEffectiveRenderer`.
   */
  defaultRenderers?: Record<string, unknown>;
  /** Kind vs role profile. Omit for default ('kind'). */
  profileKind?: "kind" | "role";
  /** For profileKind='role': which base-kind profile slugs this role can attach to. */
  applicableKinds?: string[];
  /**
   * Role-category grouping key (migration 0222). Clusters role-profiles so an
   * automation can select entities wearing ANY role in the category via
   * `entity.query { roleCategory }` — e.g. every supply role tagged
   * `roleCategory: "provider"`. NULL/omitted = no category.
   */
  roleCategory?: string | null;
  /**
   * Per-kind AI behavioral posture (base layer). Workspace overlay lives at
   * workspaces.settings.profileAiPosture[slug]; resolved by getEffectiveAiPosture().
   * Pass `null` to clear (falls back to code defaults).
   */
  aiPosture?: AiPosture | null;
}

/**
 * THE ONE DOOR for "what entity_scope does this profile get?".
 *
 * Doctrine (APP-DOCK-MENTAL-MODEL-PLAN.md §1b, ratified 2026-08-01):
 *
 *   KIND = POD-WIDE.  It is the entity's identity — one `person`, one
 *                     `company`, shared by the whole pod.
 *   ROLE = WORKSPACE-SCOPED. The space that created the role is the space that
 *                     sees it. Role *instances* live in `entity_facets` and
 *                     carry their own per-row `workspaceId`; the role PROFILE's
 *                     `entityScope` must never claim pod-wide reach.
 *
 * Why this lives here and not in a column default or a CHECK constraint:
 *
 *  - A Postgres column DEFAULT cannot read a sibling column, so it cannot
 *    express "role ⇒ workspace". Migration 0220 flips the default to `'pod'`,
 *    which is only a floor for writers that omit the column entirely (raw SQL,
 *    psql, future migrations) — the Drizzle write path never reached it,
 *    because the repository always supplied a value.
 *  - A CHECK constraint cannot be used either: `profileKind='kind' ⇒
 *    entity_scope='pod'` is NOT a true invariant. Workspace-scoped kinds are
 *    legitimate and deliberate (Deal, Pipeline, the devplane types seeded by
 *    `ensureSystemProfiles`). A CHECK would refuse rows the product wants.
 *  - Only this layer can distinguish "the caller OMITTED entityScope" from
 *    "the caller explicitly asked for workspace" — which is the entire
 *    difference between a silent-wrong default and a deliberate choice.
 *
 * Throws on `role` + `pod`, which is a contradiction with no legitimate use:
 * a role that claims pod-wide entity reach would make one space's role
 * definition govern visibility in every other space.
 */
export function resolveEntityScope(
  slug: string,
  profileKind: "kind" | "role" | undefined,
  entityScope: "pod" | "workspace" | undefined
): "pod" | "workspace" {
  const kind = profileKind ?? "kind";

  if (kind === "role" && entityScope === "pod") {
    throw new Error(
      `Profile '${slug}': profileKind='role' cannot declare entityScope='pod'. ` +
        `A role is workspace-scoped by definition — the space that creates the ` +
        `role is the space that sees it, and role instances carry their own ` +
        `workspaceId on entity_facets. Drop entityScope (it resolves to ` +
        `'workspace') or declare the profile as profileKind='kind'.`
    );
  }

  if (entityScope !== undefined) return entityScope;

  if (kind === "role") return "workspace";

  // A kind with no declared entityScope now lands POD-WIDE — the doctrine
  // default, and the inverse of the pre-0220 behaviour. Surfaced so an operator
  // can see which writer is relying on the default; it is NOT an error, and it
  // must NOT throw: the template-install path
  // (`reconcile-workspace-from-definition.ts`) and the entity auto-create paths
  // legitimately omit it, and throwing would block every template package
  // published before this doctrine existed.
  console.warn(
    `[profiles] '${slug}': profileKind='kind' declared no entityScope — ` +
      `defaulting to 'pod' (kinds are pod-wide). Declare ` +
      `entityScope: 'workspace' explicitly if this kind is app-specific.`
  );
  return "pod";
}

/** Optional narrowing for callers that already resolved profile identity. */
export interface AccessibleProfileFilters {
  ids?: string[];
  slugs?: string[];
}

export class ProfileRepository {
  constructor(private db: PostgresJsDatabase<typeof schema>) {}

  /**
   * Create a new profile
   */
  async create(input: CreateProfileInput): Promise<Profile> {
    // A slug whose concept has a first-class home elsewhere (`project` ⇒ the
    // `projects` table) can never become an entity profile. Checked HERE
    // because this method is the floor under every create door — tRPC
    // `profiles.createProfile`, MCP `synap_define_kind`, the proposal
    // materializer, template install, workspace-definition reconcile, and
    // `ensureSystemProfiles` all land on it.
    assertProfileSlugNotReserved(input.slug);

    // Validate parent profile exists if provided
    if (input.parentProfileId) {
      const parent = await this.getById(input.parentProfileId);
      if (!parent) {
        throw new Error(`Parent profile ${input.parentProfileId} not found`);
      }
    }

    // Default semanticSlug to slug — every profile is cross-workspace queryable by default.
    // Pass null explicitly to mark a profile as private (no cross-workspace semantics).
    const resolvedSemanticSlug =
      input.semanticSlug !== undefined ? input.semanticSlug : input.slug;

    const resolvedEntityScope = resolveEntityScope(
      input.slug,
      input.profileKind,
      input.entityScope
    );

    const [profile] = await this.db
      .insert(profiles)
      .values({
        ...(input.id ? { id: input.id } : {}),
        slug: input.slug,
        displayName: input.displayName,
        parentProfileId: input.parentProfileId || null,
        uiHints: input.uiHints || {},
        defaultValues: input.defaultValues || {},
        scope: input.scope || ProfileScope.WORKSPACE,
        entityScope: resolvedEntityScope,
        userId: input.userId || null,
        workspaceId: input.workspaceId || null,
        semanticSlug: resolvedSemanticSlug,
        isActive: true,
        version: 1,
        ...(input.profileKind ? { profileKind: input.profileKind } : {}),
        ...(input.applicableKinds
          ? { applicableKinds: input.applicableKinds }
          : {}),
        ...(input.roleCategory != null
          ? { roleCategory: input.roleCategory }
          : {}),
      } as NewProfile)
      .returning();

    return profile;
  }

  /**
   * Get a profile by slug, workspace-aware.
   *
   * - With workspaceId: returns the best-matching profile accessible to that
   *   workspace (workspace-owned > shared > system). Same as getBySlugForWorkspace.
   * - Without workspaceId: returns only system or shared profiles (pod-wide concepts).
   *   Use this for contexts that have no workspace (scripts, system jobs, etc.).
   */
  async getBySlug(
    slug: string,
    workspaceId?: string,
    userId?: string
  ): Promise<Profile | null> {
    if (workspaceId) {
      return this.getBySlugForWorkspace(slug, workspaceId);
    }
    // No workspace context. Base floor = pod-wide concepts (SYSTEM + SHARED).
    // When a userId is known, broaden to the caller's REAL floor: their own
    // USER profiles + profiles owned by / shared to a MEMBER workspace (member
    // workspaces only — never other users'/non-member private profiles). This
    // mirrors getAccessibleProfiles' workspace-less branch so a slug `get`
    // resolves the same set. Setup/system callers pass no userId → floor only.
    const scopeBranches = [
      eq(profiles.scope, ProfileScope.SYSTEM),
      eq(profiles.scope, ProfileScope.SHARED),
    ];
    if (userId) {
      // Same floor as getAccessibleProfiles' workspace-less branch — member ∪
      // OWNED ∪ POD-VISIBLE — which is what the comment above promises. It used
      // to be membership-only here too, so a sovereign pod owner with no member
      // row resolved a DIFFERENT (smaller) set from `get` than from `list`.
      const visibleWorkspaceIds = unionAll(
        memberWorkspaceIdsQuery(userId),
        ownedWorkspaceIdsQuery(userId),
        podVisibleWorkspaceIdsQuery()
      );
      scopeBranches.push(
        and(
          eq(profiles.scope, ProfileScope.USER),
          eq(profiles.userId, userId)
        )!,
        and(
          eq(profiles.scope, ProfileScope.WORKSPACE),
          inArray(profiles.workspaceId, visibleWorkspaceIds)
        )!
      );
    }
    // Deterministic twin resolution: one slug can be carried by several rows
    // (system row + workspace-scope twin). findFirst has no ORDER BY, so which
    // twin won was arbitrary — and this resolver feeds entities.create's
    // entityScope decision and FacetRepository.attach's profile pick, making
    // entity visibility scope nondeterministic on twin slugs. Pick by
    // specificity (most caller-specific wins), mirroring
    // getBySlugForWorkspace's priority sort; created_at ASC as tie-break.
    const rows = await this.db.query.profiles.findMany({
      where: and(
        eq(profiles.slug, slug),
        eq(profiles.isActive, true),
        or(...scopeBranches)
      ),
    });
    if (rows.length === 0) return null;
    const priority = (p: Profile) => {
      if (p.scope === ProfileScope.USER) return 0;
      if (p.scope === ProfileScope.WORKSPACE) return 1;
      if (p.scope === ProfileScope.SHARED) return 2;
      return 3; // system
    };
    rows.sort(
      (a, b) =>
        priority(a) - priority(b) ||
        a.createdAt.getTime() - b.createdAt.getTime()
    );
    return rows[0];
  }

  /**
   * Get the best-matching profile for a slug within a workspace context.
   *
   * Priority order:
   *   1. Workspace-owned profile (scope=workspace, workspaceId matches)
   *   2. Shared profile the workspace has access to (scope=shared + profile_workspace_access row)
   *   3. System profile (scope=system)
   *
   * Returns null if no matching profile is accessible to this workspace.
   */
  async getBySlugForWorkspace(
    slug: string,
    workspaceId: string
  ): Promise<Profile | null> {
    // Fetch all profiles with this slug that are accessible
    const rows = await this.db
      .select({
        p: profiles,
        accessWorkspaceId: profileWorkspaceAccess.workspaceId,
      })
      .from(profiles)
      .leftJoin(
        profileWorkspaceAccess,
        and(
          eq(profileWorkspaceAccess.profileId, profiles.id),
          eq(profileWorkspaceAccess.workspaceId, workspaceId)
        )
      )
      .where(
        and(
          eq(profiles.slug, slug),
          eq(profiles.isActive, true),
          or(
            eq(profiles.scope, ProfileScope.SYSTEM),
            and(
              eq(profiles.scope, ProfileScope.WORKSPACE),
              eq(profiles.workspaceId, workspaceId)
            ),
            and(
              eq(profiles.scope, ProfileScope.SHARED),
              // accessWorkspaceId will be non-null only if the join matched
              sql`${profileWorkspaceAccess.workspaceId} IS NOT NULL`
            )
          )
        )
      );

    if (rows.length === 0) return null;

    // Pick by priority: workspace > shared > system
    const priority = (p: Profile) => {
      if (p.scope === ProfileScope.WORKSPACE) return 0;
      if (p.scope === ProfileScope.SHARED) return 1;
      return 2; // system
    };

    rows.sort((a, b) => priority(a.p) - priority(b.p));
    return rows[0].p;
  }

  /**
   * All active profiles carrying a slug, across EVERY scope (system/shared/
   * workspace/user) and workspace. Unlike `getBySlug`/`getBySlugForWorkspace`
   * this applies NO visibility floor — it is the pod-wide DEDUP probe used by
   * the template-apply resolver to detect an existing profile (even one owned by
   * another workspace) so it can resolve-and-share instead of minting a
   * duplicate. NEVER use this for a user-facing read; it is a provisioning-time
   * existence check only.
   */
  async findActiveBySlugAnyScope(slug: string): Promise<Profile[]> {
    return this.db.query.profiles.findMany({
      where: and(eq(profiles.slug, slug), eq(profiles.isActive, true)),
    });
  }

  /**
   * Every row holding this slug at POD-WIDE scope — INCLUDING soft-deleted ones.
   *
   * This mirrors the `profiles_slug_system_shared_uniq` partial unique index
   * EXACTLY (`ON (slug) WHERE scope IN ('system','shared')` — note it has NO
   * `is_active` predicate, see `migrations/0000_baseline_schema.sql:269-271`).
   * Because `delete()` is a SOFT delete (`isActive = false`), a deleted shared
   * row is invisible to `findActiveBySlugAnyScope` but STILL HOLDS the index —
   * so flipping another row's scope to `shared` would raise a unique violation.
   * The template-apply resolver uses this to know, BEFORE writing, whether a
   * promotion to `shared` is even possible. Provisioning-time probe only — no
   * visibility floor; never use for a user-facing read.
   */
  async findPodWideBySlugIncludingInactive(slug: string): Promise<Profile[]> {
    return this.db.query.profiles.findMany({
      where: and(
        eq(profiles.slug, slug),
        inArray(profiles.scope, [ProfileScope.SYSTEM, ProfileScope.SHARED])
      ),
    });
  }

  /**
   * Every row holding this slug at WORKSPACE scope in a given workspace —
   * INCLUDING soft-deleted ones.
   *
   * The is_active-blind SIBLING of `findPodWideBySlugIncludingInactive`. This
   * mirrors the `profiles_slug_workspace_uniq` partial unique index EXACTLY
   * (`ON (slug, workspace_id) WHERE scope = 'workspace'` — note it has NO
   * `is_active` predicate, see `migrations/0000_baseline_schema.sql:273-275`).
   * Because `delete()` is a SOFT delete (`isActive = false`), a deleted
   * workspace-scoped row is invisible to `findActiveBySlugAnyScope` but STILL
   * HOLDS the seat — so a workspace-scoped `create()` for that slug would raise
   * a unique violation and abort the whole apply. The template-apply resolver
   * uses this to know, BEFORE writing, whether the seat is free (and to revive
   * the holder instead of crashing). Provisioning-time probe only — no
   * visibility floor; never use for a user-facing read.
   */
  async findWorkspaceScopedBySlugIncludingInactive(
    slug: string,
    workspaceId: string
  ): Promise<Profile[]> {
    return this.db.query.profiles.findMany({
      where: and(
        eq(profiles.slug, slug),
        eq(profiles.workspaceId, workspaceId),
        eq(profiles.scope, ProfileScope.WORKSPACE)
      ),
    });
  }

  /**
   * Get profile by ID
   */
  async getById(id: string): Promise<Profile | null> {
    const result = await this.db.query.profiles.findFirst({
      where: eq(profiles.id, id),
    });

    return result || null;
  }

  /**
   * Grant a workspace access to a shared profile.
   * Safe to call multiple times (no-op if access already exists).
   */
  async grantAccess(profileId: string, workspaceId: string): Promise<void> {
    await this.db
      .insert(profileWorkspaceAccess)
      .values({ profileId, workspaceId })
      .onConflictDoNothing();
  }

  /**
   * Revoke a workspace's access to a shared profile.
   */
  async revokeAccess(profileId: string, workspaceId: string): Promise<void> {
    await this.db
      .delete(profileWorkspaceAccess)
      .where(
        and(
          eq(profileWorkspaceAccess.profileId, profileId),
          eq(profileWorkspaceAccess.workspaceId, workspaceId)
        )
      );
  }

  /**
   * Get all workspaces that have access to a shared profile.
   */
  async getGrantedWorkspaces(profileId: string): Promise<string[]> {
    const rows = await this.db
      .select({ workspaceId: profileWorkspaceAccess.workspaceId })
      .from(profileWorkspaceAccess)
      .where(eq(profileWorkspaceAccess.profileId, profileId));
    return rows.map((r) => r.workspaceId);
  }

  /**
   * Get accessible profiles for a user/workspace.
   *
   * Returns: system profiles + workspace-owned profiles + user profiles
   *          + shared profiles explicitly granted to this workspace.
   *
   * Uses a single LEFT JOIN query (1 round-trip) instead of 3 sequential queries.
   */
  async getAccessibleProfiles(
    userId: string,
    workspaceId: string,
    filters?: AccessibleProfileFilters
  ): Promise<Profile[]> {
    // An explicit empty selection means no profile rows. This is useful for
    // progressive schema reads and avoids emitting an invalid `IN ()` clause.
    if (
      (filters?.ids !== undefined && filters.ids.length === 0) ||
      (filters?.slugs !== undefined && filters.slugs.length === 0)
    ) {
      return [];
    }
    // A workspace-less context (capture/structure when no workspace is active,
    // hydration onboarding) passes "" here. The workspace-scoped predicates bind
    // workspaceId into UUID columns, so binding "" makes Postgres throw
    // `invalid input syntax for type uuid: ""`. When there is no workspace, drop
    // every workspace-scoped branch and return SYSTEM + USER profiles only —
    // exactly what a workspace-less user should see (and what callers document).
    const hasWorkspace = Boolean(workspaceId);

    // Join only on profileId when workspace-less (never binds "" to a uuid). The
    // SHARED branch — which depends on a matched access row — is dropped below in
    // that case, so the broader join can't widen the result.
    const joinCondition = hasWorkspace
      ? and(
          eq(profileWorkspaceAccess.profileId, profiles.id),
          eq(profileWorkspaceAccess.workspaceId, workspaceId)
        )
      : eq(profileWorkspaceAccess.profileId, profiles.id);

    // The caller's REAL floor of workspaces. This MUST be the same floor
    // `userVisibleWhere` uses — member ∪ OWNED ∪ POD-VISIBLE — not membership
    // alone. `workspaces.owner_id` is a first-class column separate from
    // `workspace_members`, and on a sovereign single-user pod the owner often
    // has NO member row; flooring on membership alone silently returned
    // SYSTEM + USER profiles only, i.e. a truncated vocabulary at pod altitude
    // (kinds/roles simply missing from pickers). Composed from the shared
    // branch builders so there is one definition of the floor, not a fourth copy.
    const visibleWorkspaceIds = unionAll(
      memberWorkspaceIdsQuery(userId),
      ownedWorkspaceIdsQuery(userId),
      podVisibleWorkspaceIdsQuery()
    );

    const scopeBranches = [
      eq(profiles.scope, ProfileScope.SYSTEM),
      and(eq(profiles.scope, ProfileScope.USER), eq(profiles.userId, userId)),
    ];
    if (hasWorkspace) {
      scopeBranches.push(
        and(
          eq(profiles.scope, ProfileScope.WORKSPACE),
          eq(profiles.workspaceId, workspaceId)
        ),
        and(
          eq(profiles.scope, ProfileScope.SHARED),
          isNotNull(profileWorkspaceAccess.workspaceId)
        )
      );
    } else {
      // No active workspace: broaden to the caller's member-workspace floor
      // instead of SYSTEM+USER only — mirrors user-visible-where's member-ws
      // semi-join and the union listMulti computes. Correlated subqueries let
      // Postgres run these as semi-joins (one round-trip, no client fan-out).
      scopeBranches.push(
        and(
          eq(profiles.scope, ProfileScope.WORKSPACE),
          inArray(profiles.workspaceId, visibleWorkspaceIds)
        ),
        and(
          eq(profiles.scope, ProfileScope.SHARED),
          sql`EXISTS (
            SELECT 1 FROM ${profileWorkspaceAccess}
            WHERE ${profileWorkspaceAccess.profileId} = ${profiles.id}
              AND ${profileWorkspaceAccess.workspaceId} IN (${visibleWorkspaceIds})
          )`
        )
      );
    }

    const selectionConditions = [
      eq(profiles.isActive, true),
      or(...scopeBranches),
    ];
    if (filters?.ids)
      selectionConditions.push(inArray(profiles.id, filters.ids));
    if (filters?.slugs)
      selectionConditions.push(inArray(profiles.slug, filters.slugs));

    const rows = await this.db
      .selectDistinctOn([profiles.id], { p: profiles })
      .from(profiles)
      .leftJoin(profileWorkspaceAccess, joinCondition)
      .where(and(...selectionConditions))
      .orderBy(profiles.id, profiles.displayName);

    return rows.map((r) => r.p);
  }

  /**
   * Get profile hierarchy (root → leaf)
   */
  async getHierarchy(profileId: string): Promise<Profile[]> {
    const hierarchy: Profile[] = [];
    let current: Profile | null = await this.getById(profileId);

    while (current) {
      hierarchy.push(current);
      if (current.parentProfileId) {
        current = await this.getById(current.parentProfileId);
      } else {
        break;
      }
    }

    return hierarchy.reverse(); // Root → Leaf
  }

  /**
   * Get all profiles that share a semantic slug, optionally filtered to specific workspaces.
   *
   * Use this for cross-workspace queries: "give me all profiles that represent 'task'
   * across workspaces A, B and C" — each workspace may have its own schema but they
   * all refer to the same concept.
   */
  async getBySemanticSlug(
    semanticSlug: string,
    workspaceIds?: string[]
  ): Promise<Profile[]> {
    const conditions = [
      eq(profiles.semanticSlug, semanticSlug),
      eq(profiles.isActive, true),
    ];
    if (workspaceIds && workspaceIds.length > 0) {
      conditions.push(inArray(profiles.workspaceId, workspaceIds));
    }
    return this.db.query.profiles.findMany({
      where: and(...conditions),
    });
  }

  /**
   * Update profile
   */
  async update(
    id: string,
    input: Partial<CreateProfileInput>
  ): Promise<Profile> {
    const updateData: Partial<NewProfile> = {};

    if (input.displayName !== undefined)
      updateData.displayName = input.displayName;
    if (input.parentProfileId !== undefined)
      updateData.parentProfileId = input.parentProfileId || null;
    if (input.uiHints !== undefined) updateData.uiHints = input.uiHints;
    if (input.defaultValues !== undefined)
      updateData.defaultValues = input.defaultValues;
    if (input.scope !== undefined) updateData.scope = input.scope;
    if (input.entityScope !== undefined)
      updateData.entityScope = input.entityScope;
    if (input.userId !== undefined) updateData.userId = input.userId || null;
    if (input.workspaceId !== undefined)
      updateData.workspaceId = input.workspaceId || null;
    if (input.defaultListRenderer !== undefined)
      updateData.defaultListRenderer = input.defaultListRenderer;
    if (input.defaultDetailRenderer !== undefined)
      updateData.defaultDetailRenderer = input.defaultDetailRenderer;
    if (input.defaultDashboardRenderer !== undefined)
      updateData.defaultDashboardRenderer = input.defaultDashboardRenderer;
    if (input.defaultRenderers !== undefined)
      updateData.defaultRenderers = input.defaultRenderers;
    if (input.aiPosture !== undefined) updateData.aiPosture = input.aiPosture;

    // Increment version on update
    const current = await this.getById(id);
    if (current) {
      updateData.version = current.version + 1;
    }

    // Same doctrine floor as create(): an UPDATE must not be the back door that
    // makes a role pod-wide. `update()` never writes profile_kind, so the live
    // row is the authority on which kind this is.
    if (input.entityScope !== undefined && current) {
      resolveEntityScope(
        current.slug,
        current.profileKind as "kind" | "role",
        input.entityScope
      );
    }

    updateData.updatedAt = new Date();

    const [profile] = await this.db
      .update(profiles)
      .set(updateData)
      .where(eq(profiles.id, id))
      .returning();

    if (!profile) {
      throw new Error(`Profile ${id} not found`);
    }

    return profile;
  }

  /**
   * Revive a soft-deleted profile — the exact inverse of `delete()`.
   *
   * `update()` cannot do this: `isActive` is deliberately absent from
   * `CreateProfileInput`, so un-deleting is not reachable through the general
   * patch door. It needs to be reachable because the `profiles_slug_*_uniq`
   * indexes are is_active-BLIND while `delete()` is a SOFT delete: a deleted row
   * still occupies the slug's unique seat, so a create for that slug raises
   * 23505. Reviving the holder is the only outcome that is neither a crash nor a
   * duplicate — it is the same slug in the same place, merely soft-deleted.
   * Returns the revived row so the caller can reuse it directly.
   */
  async reactivate(id: string): Promise<Profile> {
    // The reservation is a floor on the LIVE state of the table, not only on
    // inserts: migration 0151 retired the `project` profile by flipping
    // `is_active = false`, and this method is the exact inverse of that flip.
    // Without the check here the reservation would be one `reactivate()` call
    // deep. Takes an id, so the slug has to be loaded to be judged.
    const current = await this.getById(id);
    if (current) assertProfileSlugNotReserved(current.slug);

    const [profile] = await this.db
      .update(profiles)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(profiles.id, id))
      .returning();

    if (!profile) {
      throw new Error(`Profile ${id} not found`);
    }

    return profile;
  }

  /**
   * Delete profile (soft delete)
   */
  async delete(id: string): Promise<void> {
    await this.db
      .update(profiles)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(profiles.id, id));
  }
}
