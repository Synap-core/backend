/**
 * Profile Relation Repository
 *
 * Handles linking profiles to each other via relation definitions.
 * Junction table pattern — same as ProfilePropertyRepository.
 */

import { eq, and, or } from "drizzle-orm";
import {
  profileRelations,
  type ProfileRelation,
  type NewProfileRelation,
} from "../schema/profile-relations.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export interface LinkProfileRelationInput {
  sourceProfileId: string;
  targetProfileId: string;
  relationDefId: string;
  displayOrder?: number;
  metadata?: Record<string, unknown>;
}

export class ProfileRelationRepository {
  constructor(private db: PostgresJsDatabase<typeof schema>) {}

  /**
   * Link two profiles via a relation definition
   */
  async link(input: LinkProfileRelationInput): Promise<ProfileRelation> {
    const [link] = await this.db
      .insert(profileRelations)
      .values({
        sourceProfileId: input.sourceProfileId,
        targetProfileId: input.targetProfileId,
        relationDefId: input.relationDefId,
        displayOrder: input.displayOrder || 0,
        metadata: input.metadata || {},
      } as NewProfileRelation)
      .onConflictDoUpdate({
        target: [
          profileRelations.sourceProfileId,
          profileRelations.targetProfileId,
          profileRelations.relationDefId,
        ],
        set: {
          displayOrder:
            input.displayOrder !== undefined
              ? input.displayOrder
              : profileRelations.displayOrder,
          metadata:
            input.metadata !== undefined
              ? input.metadata
              : profileRelations.metadata,
        },
      })
      .returning();

    return link;
  }

  /**
   * Unlink two profiles
   */
  async unlink(
    sourceProfileId: string,
    targetProfileId: string,
    relationDefId: string
  ): Promise<void> {
    await this.db
      .delete(profileRelations)
      .where(
        and(
          eq(profileRelations.sourceProfileId, sourceProfileId),
          eq(profileRelations.targetProfileId, targetProfileId),
          eq(profileRelations.relationDefId, relationDefId)
        )
      );
  }

  /**
   * Get all profile relations where profile is source OR target
   */
  async getByProfile(profileId: string): Promise<ProfileRelation[]> {
    return this.db.query.profileRelations.findMany({
      where: or(
        eq(profileRelations.sourceProfileId, profileId),
        eq(profileRelations.targetProfileId, profileId)
      ),
      orderBy: (profileRelations, { asc }) => [
        asc(profileRelations.displayOrder),
      ],
    });
  }

  /**
   * Get all profile relations where either source or target is in the given set.
   * Used by the data structure viewer to fetch all relations at once.
   */
  async listForProfiles(profileIds: string[]): Promise<ProfileRelation[]> {
    if (profileIds.length === 0) return [];
    return this.db.query.profileRelations.findMany({
      where: or(
        ...profileIds.map((id) => eq(profileRelations.sourceProfileId, id)),
        ...profileIds.map((id) => eq(profileRelations.targetProfileId, id))
      ),
      orderBy: (profileRelations, { asc }) => [
        asc(profileRelations.displayOrder),
      ],
    });
  }

  /**
   * Get all outgoing relations for a source profile
   */
  async getBySourceProfile(
    sourceProfileId: string
  ): Promise<ProfileRelation[]> {
    return this.db.query.profileRelations.findMany({
      where: eq(profileRelations.sourceProfileId, sourceProfileId),
      orderBy: (profileRelations, { asc }) => [
        asc(profileRelations.displayOrder),
      ],
    });
  }
}
