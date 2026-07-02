/**
 * Profile Repository
 *
 * Handles CRUD operations for profiles (entity types).
 */

import { eq, and, or, sql, isNotNull, inArray } from "drizzle-orm";
import {
  profiles,
  profileWorkspaceAccess,
  type Profile,
  type NewProfile,
  ProfileScope,
} from "../schema/profiles.js";
import { workspaceMembers } from "../schema/workspaces.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export interface CreateProfileInput {
  slug: string;
  displayName: string;
  parentProfileId?: string;
  uiHints?: Record<string, unknown>;
  /** Default property values applied when creating a new entity of this type. */
  defaultValues?: Record<string, unknown>;
  scope?: ProfileScope;
  /** Whether entities of this profile are pod-wide or workspace-scoped */
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
}

export class ProfileRepository {
  constructor(private db: PostgresJsDatabase<typeof schema>) {}

  /**
   * Create a new profile
   */
  async create(input: CreateProfileInput): Promise<Profile> {
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

    const [profile] = await this.db
      .insert(profiles)
      .values({
        slug: input.slug,
        displayName: input.displayName,
        parentProfileId: input.parentProfileId || null,
        uiHints: input.uiHints || {},
        defaultValues: input.defaultValues || {},
        scope: input.scope || ProfileScope.WORKSPACE,
        entityScope: input.entityScope || "workspace",
        userId: input.userId || null,
        workspaceId: input.workspaceId || null,
        semanticSlug: resolvedSemanticSlug,
        isActive: true,
        version: 1,
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
      const memberWorkspaceIds = this.db
        .select({ id: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId));
      scopeBranches.push(
        and(
          eq(profiles.scope, ProfileScope.USER),
          eq(profiles.userId, userId)
        )!,
        and(
          eq(profiles.scope, ProfileScope.WORKSPACE),
          inArray(profiles.workspaceId, memberWorkspaceIds)
        )!
      );
    }
    return (
      (await this.db.query.profiles.findFirst({
        where: and(
          eq(profiles.slug, slug),
          eq(profiles.isActive, true),
          or(...scopeBranches)
        ),
      })) ?? null
    );
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
    workspaceId: string
  ): Promise<Profile[]> {
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

    // The caller's REAL floor of workspaces: the ones they're a MEMBER of.
    // Used to broaden the workspace-less branch to member-scoped WORKSPACE +
    // SHARED profiles (member workspaces only — never other users'/non-member
    // private profiles), reproducing the union listMulti already computes.
    const memberWorkspaceIds = this.db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId));

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
          inArray(profiles.workspaceId, memberWorkspaceIds)
        ),
        and(
          eq(profiles.scope, ProfileScope.SHARED),
          sql`EXISTS (
            SELECT 1 FROM ${profileWorkspaceAccess}
            WHERE ${profileWorkspaceAccess.profileId} = ${profiles.id}
              AND ${profileWorkspaceAccess.workspaceId} IN (${memberWorkspaceIds})
          )`
        )
      );
    }

    const rows = await this.db
      .selectDistinctOn([profiles.id], { p: profiles })
      .from(profiles)
      .leftJoin(profileWorkspaceAccess, joinCondition)
      .where(and(eq(profiles.isActive, true), or(...scopeBranches)))
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

    // Increment version on update
    const current = await this.getById(id);
    if (current) {
      updateData.version = current.version + 1;
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
   * Delete profile (soft delete)
   */
  async delete(id: string): Promise<void> {
    await this.db
      .update(profiles)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(profiles.id, id));
  }
}
