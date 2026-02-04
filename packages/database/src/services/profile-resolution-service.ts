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
    // Try by slug first
    let profile = await this.profileRepo.getBySlug(identifier);
    if (profile) {
      // Check if accessible
      if (await this.isAccessible(profile, userId, workspaceId)) {
        return profile;
      }
      return null;
    }

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
    if (profile.scope === "workspace" && profile.workspaceId === workspaceId)
      return true;
    if (profile.scope === "user" && profile.userId === userId) return true;
    return false;
  }

  /**
   * Get profile hierarchy (root → leaf)
   */
  async getProfileHierarchy(profileId: string): Promise<Profile[]> {
    return this.profileRepo.getHierarchy(profileId);
  }

  /**
   * Get effective properties for a profile (with inheritance)
   * Merges properties from parent profiles
   */
  async getEffectiveProperties(
    profileId: string
  ): Promise<EffectiveProperty[]> {
    // Get profile hierarchy
    const hierarchy = await this.getProfileHierarchy(profileId);

    // Collect all properties from hierarchy
    const propertyMap = new Map<string, EffectiveProperty>();

    // Process from root to leaf (parent properties first)
    for (const profile of hierarchy) {
      const profileProperties = await this.profilePropertyRepo.getByProfile(
        profile.id
      );

      for (const profileProperty of profileProperties) {
        const propertyDef = await this.propertyDefRepo.getById(
          profileProperty.propertyDefId
        );

        if (!propertyDef) continue;

        // Child profiles can override parent properties
        // But we keep the first occurrence (parent) unless explicitly overridden
        if (!propertyMap.has(propertyDef.slug)) {
          propertyMap.set(propertyDef.slug, {
            ...propertyDef,
            required: profileProperty.required,
            defaultValue: profileProperty.defaultValue,
            displayOrder: profileProperty.displayOrder,
          });
        } else {
          // Override with child values (child takes precedence)
          const existing = propertyMap.get(propertyDef.slug)!;
          propertyMap.set(propertyDef.slug, {
            ...existing,
            required: profileProperty.required || existing.required, // Child can make required
            defaultValue:
              profileProperty.defaultValue !== null
                ? profileProperty.defaultValue
                : existing.defaultValue, // Child default takes precedence
            displayOrder: profileProperty.displayOrder, // Child order takes precedence
          });
        }
      }
    }

    // Sort by display order
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
