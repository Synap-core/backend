/**
 * User Entity State Executor
 * 
 * Handles validated user entity state events:
 * - user_entity_state.update.validated (starred/pinned changes)
 * - user_entity_state.delete.validated (unstar/unpin)
 * 
 * Note: View tracking is handled directly in the router (high-frequency, no validation)
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
      const repo = new UserEntityStateRepository(db.$client);

      if (eventType === "user_entity_state.update.validated") {
        const state = await repo.update(data.userId, data.entityId, {
          starred: data.starred,
          pinned: data.pinned,
        });

        return {
          status: "completed",
          userId: state.userId,
          entityId: state.entityId,
          message: "User entity state updated successfully",
        };
      }

      if (eventType === "user_entity_state.delete.validated") {
        await repo.delete(data.userId, data.entityId);

        return {
          status: "completed",
          userId: data.userId,
          entityId: data.entityId,
          message: "User entity state deleted successfully",
        };
      }

      throw new Error(`Unknown event type: ${eventType}`);
    });
  }
);
