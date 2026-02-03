/**
 * Default Whiteboard Executor
 *
 * Creates a default main whiteboard when a workspace is created.
 * This ensures every workspace has a whiteboard ready to use.
 */

import { inngest } from "../client.js";
import { ensureDefaultWhiteboard } from "@synap/database";

/**
 * Create default whiteboard for a newly created workspace
 */
export const createDefaultWhiteboard = inngest.createFunction(
  {
    id: "create-default-whiteboard",
    name: "Create Default Whiteboard for Workspace",
    retries: 3,
  },
  { event: "workspaces.create.completed" },
  async ({ event, step }) => {
    // Event data contains the workspace object, event.user contains userId
    const workspaceId = event.data.id;
    const userId = event.user.id;

    console.log(
      `[defaultWhiteboardExecutor] Processing workspace.create.completed for workspace ${workspaceId}, user ${userId}`
    );

    return await step.run("create-default-whiteboard", async () => {
      try {
        const result = await ensureDefaultWhiteboard(workspaceId, userId);

        console.log(
          `[defaultWhiteboardExecutor] ensureDefaultWhiteboard result:`,
          result.status,
          result.message,
          result.whiteboardId
        );

        if (result.status === "error") {
          console.error(
            `[defaultWhiteboardExecutor] Failed to create default whiteboard:`,
            result.message,
            result.error
          );
          throw new Error(result.message);
        }

        return {
          status: result.status === "created" ? "completed" : "skipped",
          message: result.message,
          whiteboardId: result.whiteboardId,
          documentId: result.documentId,
        };
      } catch (error: any) {
        console.error(
          `[defaultWhiteboardExecutor] Exception during whiteboard creation:`,
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
