/**
 * Sharing Repository
 *
 * Handles all resource sharing CRUD operations with automatic event emission
 */

import { eq } from "drizzle-orm";
import { resourceShares } from "../schema/sharing.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { ResourceShare, NewResourceShare } from "../schema/sharing.js";

export interface CreateSharingInput {
  id?: string;
  resourceType: string;
  resourceId: string;
  sharedByUserId: string;
  sharedWithUserId?: string;
  sharedWithEmail?: string;
  permission: "view" | "edit" | "admin";
  metadata?: Record<string, unknown>;
}

export interface UpdateSharingInput {
  permission?: "view" | "edit" | "admin";
  metadata?: Record<string, unknown>;
}

export class SharingRepository extends BaseRepository<
  ResourceShare,
  CreateSharingInput,
  UpdateSharingInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "sharing", pluralName: "sharing" });
  }

  /**
   * Create a new sharing record
   * Emits: sharing.create.completed
   */
  async create(
    data: CreateSharingInput,
    userId: string
  ): Promise<ResourceShare> {
    const [share] = await this.db
      .insert(resourceShares)
      .values({
        id: data.id,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
        createdBy: data.sharedByUserId,
        // Map sharing-specific fields to resource share schema
        metadata: {
          sharedWithUserId: data.sharedWithUserId,
          sharedWithEmail: data.sharedWithEmail,
          permission: data.permission,
          ...data.metadata,
        },
      } as NewResourceShare)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", share, userId);

    return share;
  }

  /**
   * Update an existing sharing record
   * Emits: sharing.update.completed
   */
  async update(
    id: string,
    data: UpdateSharingInput,
    userId: string
  ): Promise<ResourceShare> {
    const [share] = await this.db
      .update(resourceShares)
      .set({
        permissions: data.permission ? { [data.permission]: true } : undefined,
        updatedAt: new Date(),
      } as Partial<NewResourceShare>)
      .where(eq(resourceShares.id, id))
      .returning();

    if (!share) {
      throw new Error("Sharing record not found");
    }

    // Emit completed event
    await this.emitCompleted("update", share, userId);

    return share;
  }

  /**
   * Delete a sharing record (revoke access)
   * Emits: sharing.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(resourceShares)
      .where(eq(resourceShares.id, id))
      .returning({ id: resourceShares.id });

    if (result.length === 0) {
      throw new Error("Sharing record not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
