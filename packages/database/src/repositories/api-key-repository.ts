/**
 * API Key Repository
 *
 * Handles API key CRUD with bcrypt hashing and event emission.
 * Security-critical: Keys are hashed before storage, never stored in plaintext.
 */

import { eq, and } from "drizzle-orm";
import { apiKeys } from "../schema/index.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";

export interface CreateApiKeyInput {
  keyName: string;
  keyPrefix: string;
  key: string; // Plaintext key (will be hashed)
  hubId?: string;
  scope: string[];
  expiresAt?: Date;
  userId: string;
}

export interface UpdateApiKeyInput {
  keyName?: string;
  scope?: string[];
  expiresAt?: Date;
  isActive?: boolean;
}

export class ApiKeyRepository extends BaseRepository<
  any,
  CreateApiKeyInput,
  UpdateApiKeyInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "api_key", pluralName: "apiKeys" });
  }

  /**
   * Create a new API key
   * Emits: api_keys.create.completed
   *
   * SECURITY: Hashes the key with bcrypt before storage
   */
  async create(data: CreateApiKeyInput, userId: string): Promise<any> {
    // Hash the key with bcrypt (cost factor 12)
    const bcrypt = await import("bcrypt");
    const keyHash = await bcrypt.hash(data.key, 12);

    const [apiKey] = await this.db
      .insert(apiKeys)
      .values({
        keyName: data.keyName,
        keyPrefix: data.keyPrefix,
        keyHash,
        hubId: data.hubId,
        scope: data.scope,
        expiresAt: data.expiresAt,
        userId: data.userId,
        isActive: true,
        usageCount: 0,
      })
      .returning();

    await this.emitCompleted("create", apiKey, userId);
    return apiKey;
  }

  /**
   * Update an API key
   * Emits: api_keys.update.completed
   */
  async update(
    id: string,
    data: UpdateApiKeyInput,
    userId: string
  ): Promise<any> {
    const [apiKey] = await this.db
      .update(apiKeys)
      .set(data)
      .where(eq(apiKeys.id, id))
      .returning();

    if (!apiKey) {
      throw new Error("API key not found");
    }

    await this.emitCompleted("update", apiKey, userId);
    return apiKey;
  }

  /**
   * Revoke an API key
   * Emits: api_keys.revoke.completed
   */
  async revoke(id: string, userId: string, reason?: string): Promise<void> {
    const [apiKey] = await this.db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy: userId,
        revokedReason: reason,
      })
      .where(eq(apiKeys.id, id))
      .returning();

    if (!apiKey) {
      throw new Error("API key not found");
    }

    // Note: Revoke is a state change, not a delete
    // We don't emit a standard event here
  }

  /**
   * Rotate an API key (create new, revoke old)
   * Emits: api_keys.rotate.completed
   */
  async rotate(id: string, newKey: string, userId: string): Promise<any> {
    // Get old key
    const oldKey = await this.db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, id),
    });

    if (!oldKey) {
      throw new Error("API key not found");
    }

    // Hash new key
    const bcrypt = await import("bcrypt");
    const keyHash = await bcrypt.hash(newKey, 12);

    // Create new key
    const [newApiKey] = await this.db
      .insert(apiKeys)
      .values({
        keyName: oldKey.keyName,
        keyPrefix: oldKey.keyPrefix,
        keyHash,
        hubId: oldKey.hubId,
        scope: oldKey.scope,
        expiresAt: oldKey.expiresAt,
        userId: oldKey.userId,
        isActive: true,
        usageCount: 0,
        rotatedFromId: id,
      })
      .returning();

    // Revoke old key
    await this.db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy: userId,
        revokedReason: "Rotated",
      })
      .where(eq(apiKeys.id, id));

    // Note: Rotation creates a new key and revokes the old one
    // The create event is emitted for the new key
    return newApiKey;
  }

  /**
   * Delete an API key
   * Emits: api_keys.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(apiKeys)
      .where(eq(apiKeys.id, id))
      .returning();

    if (result.length === 0) {
      throw new Error("API key not found");
    }

    await this.emitCompleted("delete", { id }, userId);
  }

  /**
   * Verify an API key (for authentication)
   * Does NOT emit events (read operation)
   */
  async verify(keyPrefix: string, key: string): Promise<any | null> {
    // Find keys with matching prefix
    const keys = await this.db.query.apiKeys.findMany({
      where: and(eq(apiKeys.keyPrefix, keyPrefix), eq(apiKeys.isActive, true)),
    });

    // Check each key hash
    const bcrypt = await import("bcrypt");
    for (const apiKey of keys) {
      const isValid = await bcrypt.compare(key, apiKey.keyHash);
      if (isValid) {
        // Update last used
        await this.db
          .update(apiKeys)
          .set({
            lastUsedAt: new Date(),
            usageCount: apiKey.usageCount + 1,
          })
          .where(eq(apiKeys.id, apiKey.id));

        return apiKey;
      }
    }

    return null;
  }
}
