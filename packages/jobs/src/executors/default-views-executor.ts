/**
 * Default Views Executor
 *
 * Creates default structured views when a workspace is created.
 * This ensures every workspace has starter views ready to use.
 * Runs after the default whiteboard executor.
 */

import { inngest } from "../client.js";
import { ensureDefaultViews } from "@synap/database";

/**
 * Create default views for a newly created workspace
 */
export const createDefaultViews = inngest.createFunction(
  {
    id: "create-default-views",
    name: "Create Default Views for Workspace",
    retries: 3,
  },
  { event: "workspaces.create.completed" },
  async ({ event, step }) => {
    // Event data contains the workspace object, event.user contains userId
    const workspaceId = event.data.id;
    const userId = event.user.id;

    console.log(
      `[defaultViewsExecutor] Processing workspace.create.completed for workspace ${workspaceId}, user ${userId}`
    );

    return await step.run("create-default-views", async () => {
      try {
        const result = await ensureDefaultViews(workspaceId, userId);

        console.log(
          `[defaultViewsExecutor] ensureDefaultViews result:`,
          result.status,
          result.message,
          result.viewsCreated,
          result.viewIds
        );

        if (result.status === "error") {
          console.error(
            `[defaultViewsExecutor] Failed to create default views:`,
            result.message,
            result.error
          );
          throw new Error(result.message);
        }

        return {
          status: result.status === "created" ? "completed" : "skipped",
          message: result.message,
          viewsCreated: result.viewsCreated,
          viewIds: result.viewIds,
        };
      } catch (error: any) {
        console.error(
          `[defaultViewsExecutor] Exception during views creation:`,
          {
            workspaceId,
            userId,
            error: error.message,
            stack: error.stack,
          }
        );
        throw error;
      }
    });
  }
);
