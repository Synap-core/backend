/**
 * User Entity State Repository
 * 
 * Tracks user-specific interactions with entities and inbox items.
 * Uses itemId/itemType pattern to support multiple item types.
 */

import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { userEntityState, type UserEntityState } from "../schema/user-entity-state.js";

export interface UpdateUserEntityStateData {
  starred?: boolean;
  pinned?: boolean;
  lastViewedAt?: Date;
}

export class UserEntityStateRepository {
  constructor(private db: NodePgDatabase<any>) {}

  /**
   * Get or create user entity state
   */
  async getOrCreate(userId: string, itemId: string, itemType: "entity" | "inbox_item" = "entity"): Promise<UserEntityState> {
    // Try to get existing
    const [existing] = await this.db
      .select()
      .from(userEntityState)
      .where(and(
        eq(userEntityState.userId, userId),
        eq(userEntityState.itemId, itemId),
        eq(userEntityState.itemType, itemType)
      ))
      .limit(1);

    if (existing) return existing;

    // Create new
    const [state] = await this.db
      .insert(userEntityState)
      .values({
        userId,
        itemId,
        itemType,
        starred: false,
        pinned: false,
        viewCount: 0,
      })
      .returning();

    return state;
  }

  /**
   * Update user entity state (starred/pinned)
   */
  async update(
    userId: string,
    itemId: string,
    data: UpdateUserEntityStateData,
    itemType: "entity" | "inbox_item" = "entity"
  ): Promise<UserEntityState> {
    const [state] = await this.db
      .insert(userEntityState)
      .values({
        userId,
        itemId,
        itemType,
        ...data,
      })
      .onConflictDoUpdate({
        target: [userEntityState.userId, userEntityState.itemId, userEntityState.itemType],
        set: {
          ...data,
          updatedAt: new Date(),
        },
      })
      .returning();

    return state;
  }

  /**
   * Track entity view (high-frequency, direct write)
   */
  async trackView(userId: string, itemId: string, itemType: "entity" | "inbox_item" = "entity"): Promise<void> {
    await this.db
      .insert(userEntityState)
      .values({
        userId,
        itemId,
        itemType,
        lastViewedAt: new Date(),
        viewCount: 1,
      })
      .onConflictDoUpdate({
        target: [userEntityState.userId, userEntityState.itemId, userEntityState.itemType],
        set: {
          lastViewedAt: new Date(),
          viewCount: sql`${userEntityState.viewCount} + 1`,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Get user's starred items
   */
  async getStarred(userId: string, itemType?: "entity" | "inbox_item"): Promise<UserEntityState[]> {
    const conditions = [
      eq(userEntityState.userId, userId),
      eq(userEntityState.starred, true)
    ];
    
    if (itemType) {
      conditions.push(eq(userEntityState.itemType, itemType));
    }

    return await this.db
      .select()
      .from(userEntityState)
      .where(and(...conditions));
  }

  /**
   * Get user's pinned items
   */
  async getPinned(userId: string, itemType?: "entity" | "inbox_item"): Promise<UserEntityState[]> {
    const conditions = [
      eq(userEntityState.userId, userId),
      eq(userEntityState.pinned, true)
    ];
    
    if (itemType) {
      conditions.push(eq(userEntityState.itemType, itemType));
    }

    return await this.db
      .select()
      .from(userEntityState)
      .where(and(...conditions));
  }

  /**
   * Delete user entity state
   */
  async delete(userId: string, itemId: string, itemType: "entity" | "inbox_item" = "entity"): Promise<void> {
    await this.db
      .delete(userEntityState)
      .where(
        and(
          eq(userEntityState.userId, userId),
          eq(userEntityState.itemId, itemId),
          eq(userEntityState.itemType, itemType)
        )
      );
  }
}
