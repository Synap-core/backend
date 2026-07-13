import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import type { UserEntityState } from "../schema/user-entity-state.js";
import {
  UserResourceStateRepository,
  type UpdateUserResourceStateData,
} from "./user-resource-state-repository.js";

type LegacyItemType = "entity" | "inbox_item";

function toLegacy(
  state: Awaited<ReturnType<UserResourceStateRepository["get"]>>
): UserEntityState | undefined {
  if (!state) return undefined;
  return {
    ...state,
    itemId: state.resourceId,
    itemType: state.resourceType,
    lastViewedAt: state.lastOpenedAt,
    viewCount: state.openCount,
  };
}

/** @deprecated Compatibility adapter. Use UserResourceStateRepository. */
export class UserEntityStateRepository {
  private readonly resources: UserResourceStateRepository;

  constructor(db: PostgresJsDatabase<typeof schema>) {
    this.resources = new UserResourceStateRepository(db);
  }

  async getOrCreate(
    userId: string,
    itemId: string,
    itemType: LegacyItemType = "entity"
  ): Promise<UserEntityState> {
    const existing = await this.resources.get(userId, itemId, itemType);
    const state =
      existing ?? (await this.resources.update(userId, itemId, itemType, {}));
    return toLegacy(state)!;
  }

  async update(
    userId: string,
    itemId: string,
    data: UpdateUserResourceStateData & { lastViewedAt?: Date },
    itemType: LegacyItemType = "entity"
  ): Promise<UserEntityState> {
    const { lastViewedAt, ...rest } = data;
    const state = await this.resources.update(userId, itemId, itemType, {
      ...rest,
      ...(lastViewedAt ? { lastOpenedAt: lastViewedAt } : {}),
    });
    return toLegacy(state)!;
  }

  async trackView(
    userId: string,
    itemId: string,
    itemType: LegacyItemType = "entity"
  ): Promise<void> {
    await this.resources.recordOpen(userId, itemId, itemType);
  }

  async getStarred(
    userId: string,
    itemType?: LegacyItemType
  ): Promise<UserEntityState[]> {
    const states = await this.resources.listFlagged(
      userId,
      "starred",
      itemType
    );
    return states.map((state) => toLegacy(state)!);
  }

  async getPinned(
    userId: string,
    itemType?: LegacyItemType
  ): Promise<UserEntityState[]> {
    const states = await this.resources.listFlagged(userId, "pinned", itemType);
    return states.map((state) => toLegacy(state)!);
  }

  async delete(
    userId: string,
    itemId: string,
    itemType: LegacyItemType = "entity"
  ): Promise<void> {
    await this.resources.delete(userId, itemId, itemType);
  }
}

export type UpdateUserEntityStateData = UpdateUserResourceStateData & {
  lastViewedAt?: Date;
};
