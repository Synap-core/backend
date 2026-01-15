/**
 * User Entity State Executor
 * 
 * Handles validated user entity state events.
 */

import { inngest } from "../client.js";
import { UserEntityStateRepository } from "@synap/database";
import { getDb } from "@synap/database";

export const userEntityStateExecutor = inngest.createFunction(
  {
    id: "user-entity-state-executor",
    name: "User Entity State Executor",
    retries: 3,
  },
  [
    { event: "user_entity_state.update.validated" },
    { event: "user_entity_state.delete.validated" },
  ],
  async ({ event, step }) => {
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-user-entity-state-operation", async () => {
      const db = await getDb();
      const repo = new UserEntityStateRepository(db as any);

      if (eventType === "user_entity_state.update.validated") {
        const state = await repo.update(
          data.userId,
          data.itemId,
          {
            starred: data.starred,
            pinned: data.pinned,
          },
          data.itemType || "entity"
        );

        return {
          status: "completed",
          userId: state.userId,
          itemId: state.itemId,
          message: "User entity state updated successfully",
        };
      }

      if (eventType === "user_entity_state.delete.validated") {
        await repo.delete(data.userId, data.itemId, data.itemType || "entity");

        return {
          status: "completed",
          userId: data.userId,
          itemId: data.itemId,
          message: "User entity state deleted successfully",
        };
      }

      throw new Error(`Unknown event type: ${eventType}`);
    });
  }
);
