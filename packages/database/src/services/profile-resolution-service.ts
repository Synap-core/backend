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

export interface EffectiveProperty extends PropertyDef {
  required: boolean;
  defaultValue: unknown;
  displayOrder: number;
}

export class ProfileResolutionService {
  private profileRepo: ProfileRepository;
  private profilePropertyRepo: ProfilePropertyRepository;
  private propertyDefRepo: PropertyDefRepository;

  constructor(db: PostgresJsDatabase<typeof import("../schema/index.js")>) {
    this.profileRepo = new ProfileRepository(db);
    this.profilePropertyRepo = new ProfilePropertyRepository(db);
    this.propertyDefRepo = new PropertyDefRepository(db);
  }

  /**
   * Resolve profile by slug or ID
   */
  async resolveProfile(
    identifier: string,
    userId: string,
    workspaceId: string
  ): Promise<Profile | null> {
    // Try by slug first — workspace-aware, returns only what's accessible
    let profile = await this.profileRepo.getBySlug(identifier, workspaceId);
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
    workspaceId: string
  ): Promise<boolean> {
    if (profile.scope === "system") return true;
    // Profiles have a globally unique slug constraint, so workspace-scoped
    // profiles are effectively shared schema definitions across workspaces
    if (profile.scope === "workspace") return true;
    if (profile.scope === "user" && profile.userId === userId) return true;
    if (profile.scope === "shared") {
      // Check profile_workspace_access join table
      const granted = await this.profileRepo.getGrantedWorkspaces(profile.id);
      return granted.includes(workspaceId);
    }
    return false;
  }

  /**
   * Get profile hierarchy (root → leaf)
   */
  async getProfileHierarchy(profileId: string): Promise<Profile[]> {
    return this.profileRepo.getHierarchy(profileId);
  }

  /**
   * Get effective properties for a profile (with inheritance).
   * Merges properties from parent profiles; child values override parent values.
   *
   * Uses 3 flat queries regardless of hierarchy depth (no N+1):
   *   1. getHierarchy()   — profiles in ancestor chain
   *   2. getByProfiles()  — all profile_properties rows for those profiles
   *   3. getManyByIds()   — all property_defs referenced by those rows
   */
  async getEffectiveProperties(
    profileId: string
  ): Promise<EffectiveProperty[]> {
    // 1. Profile hierarchy (root → leaf) — 1 query per level (small, bounded depth)
    const hierarchy = await this.getProfileHierarchy(profileId);
    if (hierarchy.length === 0) return [];

    // 2. All profile-property links for every profile in the hierarchy — 1 query
    const profileIds = hierarchy.map((p) => p.id);
    const allProfileProperties =
      await this.profilePropertyRepo.getByProfiles(profileIds);

    if (allProfileProperties.length === 0) return [];

    // 3. All property defs referenced by those links — 1 query
    const propDefIds = [
      ...new Set(allProfileProperties.map((pp) => pp.propertyDefId)),
    ];
    const propDefMap = await this.propertyDefRepo.getManyByIds(propDefIds);

    // Merge: process root-to-leaf so child values override parent values
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
   * Get effective property by slug
   */
  async getEffectiveProperty(
    profileId: string,
    propertySlug: string
  ): Promise<EffectiveProperty | null> {
    const properties = await this.getEffectiveProperties(profileId);
    return properties.find((p) => p.slug === propertySlug) || null;
  }
}
