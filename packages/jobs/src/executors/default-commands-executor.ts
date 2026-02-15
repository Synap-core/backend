/**
 * Default Commands Executor
 *
 * Seeds default intelligence commands when a workspace is created.
 * Ensures every workspace has the Default Command Pack v1 ready to use.
 */

import { inngest } from "../client.js";
import { ensureDefaultCommands } from "@synap/database";

export const createDefaultCommands = inngest.createFunction(
  {
    id: "create-default-commands",
    name: "Create Default Commands for Workspace",
    retries: 3,
  },
  { event: "workspace.create.completed" },
  async ({ event, step }) => {
    const workspaceId = event.data.id;
    const userId = event.user.id;

    console.log(
      `[defaultCommandsExecutor] Processing workspace.create.completed for workspace ${workspaceId}, user ${userId}`
    );

    return await step.run("create-default-commands", async () => {
      try {
        const result = await ensureDefaultCommands(workspaceId, userId);

        console.log(
          `[defaultCommandsExecutor] ensureDefaultCommands result:`,
          result.status,
          result.message,
          result.commandsCreated,
          result.commandIds
        );

        if (result.status === "error") {
          console.error(
            `[defaultCommandsExecutor] Failed to create default commands:`,
            result.message,
            result.error
          );
          throw new Error(result.message);
        }

        return {
          status: result.status === "created" ? "completed" : "skipped",
          message: result.message,
          commandsCreated: result.commandsCreated,
          commandIds: result.commandIds,
        };
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(
          `[defaultCommandsExecutor] Exception during commands creation:`,
          { workspaceId, userId, error: err.message, stack: err.stack }
        );
        throw error;
      }
    });
  }
);
