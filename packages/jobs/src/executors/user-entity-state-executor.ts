/**
 * User Entity State Executor
 *
 * Handles validated user entity state events.
 */

import { inngest } from "../client.js";
import { UserEntityStateRepository } from "@synap/database";
import { getDb } from "@synap/database";
import {
  extractEventInfo,
  type UnifiedEventData,
} from "../types/unified-events.js";

export const userEntityStateExecutor = inngest.createFunction(
  {
    id: "user-entity-state-executor",
    name: "User Entity State Executor",
    retries: 3,
  },
  [
    { event: "userEntityState.*" },
  ],
  async ({ event, step }) => {
    const eventInfo = extractEventInfo(event.name);
    const { action, phase } = eventInfo;
    const data = event.data as UnifiedEventData;

    // Ensure we're handling a validated event
    if (phase !== "validated") {
      console.warn(
        `[userEntityStateExecutor] Received non-validated event: ${event.name}`
      );
      return { success: false, reason: "Not a validated event" };
    }

    return await step.run("execute-user-entity-state-operation", async () => {
      const db = await getDb();
      const repo = new UserEntityStateRepository(db);

      if (action === "update") {
        const state = await repo.update(
          data.userId as string,
          data.itemId as string,
          {
            starred: data.starred as boolean | undefined,
            pinned: data.pinned as boolean | undefined,
          },
          (data.itemType as "entity" | "inbox_item" | undefined) || "entity"
        );

        return {
          status: "completed",
          userId: state.userId,
          itemId: state.itemId,
          message: "User entity state updated successfully",
        };
      }

      if (action === "delete") {
        await repo.delete(
          data.userId as string,
          data.itemId as string,
          (data.itemType as "entity" | "inbox_item" | undefined) || "entity"
        );

        return {
          status: "completed",
          userId: data.userId as string,
          itemId: data.itemId as string,
          message: "User entity state deleted successfully",
        };
      }

      throw new Error(`Unknown action: ${action}`);
    });
  }
);
