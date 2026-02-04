/**
 * Profile Repository
 *
 * Handles CRUD operations for profiles (entity types).
 */

import { eq, and, or } from "drizzle-orm";
import {
  profiles,
  type Profile,
  type NewProfile,
  ProfileScope,
} from "../schema/profiles.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export interface CreateProfileInput {
  slug: string;
  displayName: string;
  parentProfileId?: string;
  uiHints?: Record<string, unknown>;
  scope?: ProfileScope;
  userId?: string;
  workspaceId?: string;
}

export class ProfileRepository {
  constructor(
    private db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ) {}

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

    const [profile] = await this.db
      .insert(profiles)
      .values({
        slug: input.slug,
        displayName: input.displayName,
        parentProfileId: input.parentProfileId || null,
        uiHints: input.uiHints || {},
        scope: input.scope || ProfileScope.WORKSPACE,
        userId: input.userId || null,
        workspaceId: input.workspaceId || null,
        isActive: true,
        version: 1,
      } as NewProfile)
      .returning();

    return profile;
  }

  /**
   * Get profile by slug
   */
  async getBySlug(slug: string): Promise<Profile | null> {
    const result = await this.db.query.profiles.findFirst({
      where: eq(profiles.slug, slug),
    });

    return result || null;
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
   * Get accessible profiles for a user/workspace
   * Returns: system profiles + workspace profiles + user profiles
   */
  async getAccessibleProfiles(
    userId: string,
    workspaceId: string
  ): Promise<Profile[]> {
    return this.db.query.profiles.findMany({
      where: and(
        eq(profiles.isActive, true),
        or(
          eq(profiles.scope, ProfileScope.SYSTEM),
          and(
            eq(profiles.scope, ProfileScope.WORKSPACE),
            eq(profiles.workspaceId, workspaceId)
          ),
          and(
            eq(profiles.scope, ProfileScope.USER),
            eq(profiles.userId, userId)
          )
        )
      ),
      orderBy: (profiles, { asc }) => [asc(profiles.displayName)],
    });
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
    if (input.scope !== undefined) updateData.scope = input.scope;
    if (input.userId !== undefined) updateData.userId = input.userId || null;
    if (input.workspaceId !== undefined)
      updateData.workspaceId = input.workspaceId || null;

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
