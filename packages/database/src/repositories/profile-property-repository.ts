/**
 * Profile Property Repository
 *
 * Handles linking profiles to property definitions.
 */

import { eq, and, inArray } from "drizzle-orm";
import {
  profileProperties,
  type ProfileProperty,
  type NewProfileProperty,
} from "../schema/profile-properties.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export interface LinkProfilePropertyInput {
  profileId: string;
  propertyDefId: string;
  required?: boolean;
  defaultValue?: unknown;
  displayOrder?: number;
}

export class ProfilePropertyRepository {
  constructor(private db: PostgresJsDatabase<typeof schema>) {}

  /**
   * Link a property to a profile
   */
  async link(input: LinkProfilePropertyInput): Promise<ProfileProperty> {
    const [link] = await this.db
      .insert(profileProperties)
      .values({
        profileId: input.profileId,
        propertyDefId: input.propertyDefId,
        required: input.required || false,
        defaultValue:
          input.defaultValue !== undefined ? input.defaultValue : null,
        displayOrder: input.displayOrder || 0,
      } as NewProfileProperty)
      .onConflictDoUpdate({
        target: [profileProperties.profileId, profileProperties.propertyDefId],
        set: {
          required:
            input.required !== undefined
              ? input.required
              : profileProperties.required,
          defaultValue:
            input.defaultValue !== undefined
              ? input.defaultValue
              : profileProperties.defaultValue,
          displayOrder:
            input.displayOrder !== undefined
              ? input.displayOrder
              : profileProperties.displayOrder,
        },
      })
      .returning();

    return link;
  }

  /**
   * Unlink a property from a profile
   */
  async unlink(profileId: string, propertyDefId: string): Promise<void> {
    await this.db
      .delete(profileProperties)
      .where(
        and(
          eq(profileProperties.profileId, profileId),
          eq(profileProperties.propertyDefId, propertyDefId)
        )
      );
  }

  /**
   * Get all properties for a profile
   */
  async getByProfile(profileId: string): Promise<ProfileProperty[]> {
    return this.db.query.profileProperties.findMany({
      where: eq(profileProperties.profileId, profileId),
      orderBy: (profileProperties, { asc }) => [
        asc(profileProperties.displayOrder),
      ],
    });
  }

  /**
   * Batch-fetch all profile-property links for a set of profile IDs.
   * Used by getEffectiveProperties() to avoid N+1 queries across the hierarchy.
   */
  async getByProfiles(profileIds: string[]): Promise<ProfileProperty[]> {
    if (profileIds.length === 0) return [];
    return this.db.query.profileProperties.findMany({
      where: inArray(profileProperties.profileId, profileIds),
      orderBy: (pp, { asc }) => [asc(pp.displayOrder)],
    });
  }

  /**
   * Get all profiles that use a property
   */
  async getByProperty(propertyDefId: string): Promise<ProfileProperty[]> {
    return this.db.query.profileProperties.findMany({
      where: eq(profileProperties.propertyDefId, propertyDefId),
    });
  }

  /**
   * Update link configuration
   */
  async update(
    profileId: string,
    propertyDefId: string,
    input: Partial<LinkProfilePropertyInput>
  ): Promise<ProfileProperty> {
    const updateData: Partial<NewProfileProperty> = {};

    if (input.required !== undefined) updateData.required = input.required;
    if (input.defaultValue !== undefined)
      updateData.defaultValue = input.defaultValue;
    if (input.displayOrder !== undefined)
      updateData.displayOrder = input.displayOrder;

    const [link] = await this.db
      .update(profileProperties)
      .set(updateData)
      .where(
        and(
          eq(profileProperties.profileId, profileId),
          eq(profileProperties.propertyDefId, propertyDefId)
        )
      )
      .returning();

    if (!link) {
      throw new Error(
        `Profile property link not found: profile=${profileId}, property=${propertyDefId}`
      );
    }

    return link;
  }
}
