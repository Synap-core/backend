/** Compatibility surface for the pre-resource-state field vocabulary. */
import { userResourceState } from "./user-resource-state.js";

export const userEntityState = Object.assign(userResourceState, {
  itemId: userResourceState.resourceId,
  itemType: userResourceState.resourceType,
  lastViewedAt: userResourceState.lastOpenedAt,
  viewCount: userResourceState.openCount,
});

export type UserEntityState = Omit<
  typeof userResourceState.$inferSelect,
  "resourceId" | "resourceType" | "lastOpenedAt" | "openCount"
> & {
  itemId: string;
  itemType: "entity" | "view" | "inbox_item";
  lastViewedAt: Date | null;
  viewCount: number;
};

export type NewUserEntityState = Omit<
  typeof userResourceState.$inferInsert,
  "resourceId" | "resourceType" | "lastOpenedAt" | "openCount"
> & {
  itemId: string;
  itemType: "entity" | "view" | "inbox_item";
  lastViewedAt?: Date | null;
  viewCount?: number;
};
