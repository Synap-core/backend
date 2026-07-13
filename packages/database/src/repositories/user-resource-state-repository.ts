import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import {
  userResourceState,
  type ResourceSemanticSize,
  type UserResourceState,
  type UserResourceType,
} from "../schema/user-resource-state.js";

export interface UpdateUserResourceStateData {
  starred?: boolean;
  pinned?: boolean;
  semanticSize?: ResourceSemanticSize | null;
  lastOpenedAt?: Date;
}

export class UserResourceStateRepository {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async get(
    userId: string,
    resourceId: string,
    resourceType: UserResourceType
  ): Promise<UserResourceState | undefined> {
    const [state] = await this.db
      .select()
      .from(userResourceState)
      .where(
        and(
          eq(userResourceState.userId, userId),
          eq(userResourceState.resourceId, resourceId),
          eq(userResourceState.resourceType, resourceType)
        )
      )
      .limit(1);
    return state;
  }

  async getMany(
    userId: string,
    resources: readonly {
      resourceId: string;
      resourceType: UserResourceType;
    }[]
  ): Promise<UserResourceState[]> {
    if (resources.length === 0) return [];
    const ids = Array.from(
      new Set(resources.map((resource) => resource.resourceId))
    );
    const requested = new Set(
      resources.map(
        (resource) => `${resource.resourceType}:${resource.resourceId}`
      )
    );
    const states = await this.db
      .select()
      .from(userResourceState)
      .where(
        and(
          eq(userResourceState.userId, userId),
          inArray(userResourceState.resourceId, ids)
        )
      );
    return states.filter((state) =>
      requested.has(`${state.resourceType}:${state.resourceId}`)
    );
  }

  async update(
    userId: string,
    resourceId: string,
    resourceType: UserResourceType,
    data: UpdateUserResourceStateData
  ): Promise<UserResourceState> {
    const [state] = await this.db
      .insert(userResourceState)
      .values({ userId, resourceId, resourceType, ...data })
      .onConflictDoUpdate({
        target: [
          userResourceState.userId,
          userResourceState.resourceId,
          userResourceState.resourceType,
        ],
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    return state;
  }

  async recordOpen(
    userId: string,
    resourceId: string,
    resourceType: UserResourceType
  ): Promise<UserResourceState> {
    const now = new Date();
    const [state] = await this.db
      .insert(userResourceState)
      .values({
        userId,
        resourceId,
        resourceType,
        lastOpenedAt: now,
        openCount: 1,
      })
      .onConflictDoUpdate({
        target: [
          userResourceState.userId,
          userResourceState.resourceId,
          userResourceState.resourceType,
        ],
        set: {
          lastOpenedAt: now,
          openCount: sql`${userResourceState.openCount} + 1`,
          updatedAt: now,
        },
      })
      .returning();
    return state;
  }

  async listFlagged(
    userId: string,
    flag: "starred" | "pinned",
    resourceType?: UserResourceType
  ): Promise<UserResourceState[]> {
    const conditions = [
      eq(userResourceState.userId, userId),
      eq(userResourceState[flag], true),
    ];
    if (resourceType) {
      conditions.push(eq(userResourceState.resourceType, resourceType));
    }
    return this.db
      .select()
      .from(userResourceState)
      .where(and(...conditions));
  }

  async delete(
    userId: string,
    resourceId: string,
    resourceType: UserResourceType
  ): Promise<void> {
    await this.db
      .delete(userResourceState)
      .where(
        and(
          eq(userResourceState.userId, userId),
          eq(userResourceState.resourceId, resourceId),
          eq(userResourceState.resourceType, resourceType)
        )
      );
  }
}
