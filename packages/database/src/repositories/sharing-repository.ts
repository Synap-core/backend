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
  permission?: "view" | "edit" | "admin";
  metadata?: Record<string, unknown>;
  /** Public link fields */
  publicToken?: string;
  tokenHash?: string;
  visibility?: string;
  expiresAt?: Date | null;
  access?: "workspace_only" | "anyone_with_link";
  passwordHash?: string | null;
}

export interface UpdateSharingInput {
  permission?: "view" | "edit" | "admin";
  metadata?: Record<string, unknown>;
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  tokenHash?: string;
  publicToken?: string | null;
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
        visibility: data.visibility ?? "private",
        publicToken: data.publicToken ?? null,
        tokenHash: data.tokenHash ?? null,
        passwordHash: data.passwordHash ?? null,
        access: data.access ?? "anyone_with_link",
        expiresAt: data.expiresAt ?? null,
        permissions: data.permission
          ? { [data.permission]: true }
          : { read: true },
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
    const updates: Partial<NewResourceShare> = {
      updatedAt: new Date(),
    };
    if (data.permission) updates.permissions = { [data.permission]: true };
    if (data.revokedAt !== undefined) updates.revokedAt = data.revokedAt;
    if (data.expiresAt !== undefined) updates.expiresAt = data.expiresAt;
    if (data.tokenHash !== undefined) updates.tokenHash = data.tokenHash;
    if (data.publicToken !== undefined) updates.publicToken = data.publicToken;

    const [share] = await this.db
      .update(resourceShares)
      .set(updates)
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
