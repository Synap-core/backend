/**
 * Profile Resolution Service
 *
 * Resolves profiles and their effective property sets (with inheritance).
 */

import { ProfileRepository } from "../repositories/profile-repository.js";
import { ProfilePropertyRepository } from "../repositories/profile-property-repository.js";
import { PropertyDefRepository } from "../repositories/property-def-repository.js";
import type { Profile, PropertyDef } from "../schema/index.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export interface EffectiveProperty extends PropertyDef {
  required: boolean;
  defaultValue: unknown;
  displayOrder: number;
}

export class ProfileResolutionService {
  private _db: PostgresJsDatabase<typeof schema>;
  private profileRepo: ProfileRepository;
  private profilePropertyRepo: ProfilePropertyRepository;
  private propertyDefRepo: PropertyDefRepository;

  /** TTL cache for entityScope lookups (60s) */
  private static entityScopeCache = new Map<
    string,
    { scope: "pod" | "workspace"; expiresAt: number }
  >();
  private static CACHE_TTL = 60_000;

  constructor(db: PostgresJsDatabase<typeof schema>) {
    this._db = db;
    this.profileRepo = new ProfileRepository(db);
    this.profilePropertyRepo = new ProfilePropertyRepository(db);
    this.propertyDefRepo = new PropertyDefRepository(db);
  }

  /**
   * Get the entity scope for a profile — determines whether entities of
   * this type are pod-wide (visible everywhere) or workspace-scoped.
   * Results are cached for 60 seconds.
   */
  async getEntityScope(
    profileSlug: string,
    workspaceId: string | null
  ): Promise<"pod" | "workspace"> {
    const cacheKey = `${profileSlug}:${workspaceId ?? "__nows__"}`;
    const cached = ProfileResolutionService.entityScopeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.scope;

    const profile = await this.profileRepo.getBySlugForWorkspace(
      profileSlug,
      workspaceId ?? ""
    );
    const scope = profile?.entityScope === "pod" ? "pod" : "workspace";

    ProfileResolutionService.entityScopeCache.set(cacheKey, {
      scope,
      expiresAt: Date.now() + ProfileResolutionService.CACHE_TTL,
    });

    return scope;
  }

  /** Invalidate the entityScope cache (call on profile updates) */
  static invalidateEntityScopeCache(profileSlug?: string): void {
    if (profileSlug) {
      for (const key of ProfileResolutionService.entityScopeCache.keys()) {
        if (key.startsWith(`${profileSlug}:`)) {
          ProfileResolutionService.entityScopeCache.delete(key);
        }
      }
    } else {
      ProfileResolutionService.entityScopeCache.clear();
    }
  }

  /**
   * Resolve profile by slug or ID
   */
  async resolveProfile(
    identifier: string,
    userId: string,
    workspaceId: string | null
  ): Promise<Profile | null> {
    // Try by slug first — workspace-aware, returns only what's accessible.
    // Empty string for workspaceId is the convention for "no workspace lens"
    // (workspace-less users in hydration).
    let profile = await this.profileRepo.getBySlug(
      identifier,
      workspaceId ?? ""
    );
    if (profile) return profile;

    // Try by ID
    profile = await this.profileRepo.getById(identifier);
    if (profile && (await this.isAccessible(profile, userId, workspaceId))) {
      return profile;
    }

    return null;
  }

  /**
   * Check if profile is accessible to user/workspace
   */
  private async isAccessible(
    profile: Profile,
    userId: string,
    workspaceId: string | null
  ): Promise<boolean> {
    if (profile.scope === "system") return true;
    // Profiles have a globally unique slug constraint, so workspace-scoped
    // profiles are effectively shared schema definitions across workspaces
    if (profile.scope === "workspace") return true;
    if (profile.scope === "user" && profile.userId === userId) return true;
    if (profile.scope === "shared") {
      if (!workspaceId) return false;
      // Check profile_workspace_access join table
      const granted = await this.profileRepo.getGrantedWorkspaces(profile.id);
      return granted.includes(workspaceId);
    }
    return false;
  }

  /**
   * Get all profiles accessible to a user in a workspace.
   * Pass null/empty for workspace-less contexts (returns SYSTEM + USER-scope only).
   */
  async getAccessibleProfiles(
    userId: string,
    workspaceId: string | null
  ): Promise<Profile[]> {
    return this.profileRepo.getAccessibleProfiles(userId, workspaceId ?? "");
  }

  /**
   * Get profile hierarchy (root → leaf)
   */
  async getProfileHierarchy(profileId: string): Promise<Profile[]> {
    return this.profileRepo.getHierarchy(profileId);
  }

  /**
   * Get all descendant profile slugs for a given profile slug.
   * Walks DOWN the profile tree (parent → children → grandchildren).
   * Returns only the descendant slugs (not the parent itself).
   *
   * Uses a single query to fetch all profiles and walks the tree in-memory
   * (profiles are bounded in number — typically <50 per pod).
   */
  async getDescendantSlugs(
    parentSlug: string,
    _workspaceId?: string
  ): Promise<string[]> {
    // Fetch all profiles (bounded set — typically <50 per pod)
    const allProfiles = await this._db.query.profiles.findMany({
      columns: { id: true, slug: true, parentProfileId: true },
    });

    // Build parent → children map
    const childrenOf = new Map<string, string[]>();
    const slugById = new Map<string, string>();
    const idBySlug = new Map<string, string>();

    for (const p of allProfiles) {
      slugById.set(p.id, p.slug);
      idBySlug.set(p.slug, p.id);
      if (p.parentProfileId) {
        const children = childrenOf.get(p.parentProfileId) ?? [];
        children.push(p.id);
        childrenOf.set(p.parentProfileId, children);
      }
    }

    // BFS from the parent slug
    const parentId = idBySlug.get(parentSlug);
    if (!parentId) return [];

    const result: string[] = [];
    const queue = [parentId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const children = childrenOf.get(currentId) ?? [];
      for (const childId of children) {
        const childSlug = slugById.get(childId);
        if (childSlug) {
          result.push(childSlug);
          queue.push(childId); // Continue BFS for grandchildren
        }
      }
    }

    return result;
  }

  /**
   * Get effective properties for a profile (with inheritance) as rendered
   * through a specific workspace's lens.
   *
   * Merges properties from parent profiles (child values override parent).
   * When `workspaceId` is provided, drops overlay defs owned by other
   * workspaces — the caller sees only "base" defs plus its own overlays.
   *
   * Passing `workspaceId = null | undefined` returns the full unfiltered
   * set (admin / introspection path). Almost every real caller has a
   * workspace context and should pass it.
   *
   * Uses 3 flat queries regardless of hierarchy depth (no N+1):
   *   1. getHierarchy()   — profiles in ancestor chain
   *   2. getByProfiles()  — all profile_properties rows for those profiles
   *   3. getManyByIds()   — workspace-filtered at SQL level
   */
  async getEffectiveProperties(
    profileId: string,
    workspaceId?: string | null
  ): Promise<EffectiveProperty[]> {
    // 1. Profile hierarchy (root → leaf) — 1 query per level (small, bounded depth)
    const hierarchy = await this.getProfileHierarchy(profileId);
    if (hierarchy.length === 0) return [];

    // 2. All profile-property links for every profile in the hierarchy — 1 query
    const profileIds = hierarchy.map((p) => p.id);
    const allProfileProperties =
      await this.profilePropertyRepo.getByProfiles(profileIds);

    if (allProfileProperties.length === 0) return [];

    // 3. All property defs referenced by those links — 1 query, filtered
    //    by workspace scope at SQL level (cheaper than fetch-then-drop).
    const propDefIds = [
      ...new Set(allProfileProperties.map((pp) => pp.propertyDefId)),
    ];
    const propDefMap = await this.propertyDefRepo.getManyByIds(
      propDefIds,
      workspaceId
    );

    // Merge: process root-to-leaf so child values override parent values.
    // Any propertyDef filtered out above simply won't be in the map, so the
    // matching profile_properties link is skipped — exactly the intended
    // "this workspace doesn't see that overlay" behaviour.
    const propertyMap = new Map<string, EffectiveProperty>();

    for (const profile of hierarchy) {
      const profileProperties = allProfileProperties.filter(
        (pp) => pp.profileId === profile.id
      );

      for (const profileProperty of profileProperties) {
        const propertyDef = propDefMap.get(profileProperty.propertyDefId);
        if (!propertyDef) continue;

        if (!propertyMap.has(propertyDef.slug)) {
          // First occurrence (from root) — add as-is
          propertyMap.set(propertyDef.slug, {
            ...propertyDef,
            required: profileProperty.required,
            defaultValue: profileProperty.defaultValue,
            displayOrder: profileProperty.displayOrder,
          });
        } else {
          // Child overrides: required can only go up; child default + order take precedence
          const existing = propertyMap.get(propertyDef.slug)!;
          propertyMap.set(propertyDef.slug, {
            ...existing,
            required: profileProperty.required || existing.required,
            defaultValue:
              profileProperty.defaultValue !== null
                ? profileProperty.defaultValue
                : existing.defaultValue,
            displayOrder: profileProperty.displayOrder,
          });
        }
      }
    }

    return Array.from(propertyMap.values()).sort(
      (a, b) => a.displayOrder - b.displayOrder
    );
  }

  /**
   * Get effective property by slug — scoped to the given workspace lens.
   */
  async getEffectiveProperty(
    profileId: string,
    propertySlug: string,
    workspaceId?: string | null
  ): Promise<EffectiveProperty | null> {
    const properties = await this.getEffectiveProperties(
      profileId,
      workspaceId
    );
    return properties.find((p) => p.slug === propertySlug) || null;
  }
}
