/**
 * Hub Protocol - Commands Router
 *
 * Exposes intelligence commands to the IS so AI can discover
 * available commands when building automations.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { intelligenceCommands, eq, desc } from "@synap/database";
import { AccessContext, scopedDb } from "../../access/index.js";

export const hubCommandsRouter = router({
  /**
   * List intelligence commands in a workspace.
   * Requires: hub-protocol.read scope
   */
  listCommands: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ input }) => {
      // Floor on the ACTING user (input.userId, resolved by the IS) via the
      // sharedScope-aware rule: workspace-shared commands for members of the
      // lensed workspace; sharedScope='user' commands ONLY to their creator.
      // Previously this filtered by workspaceId alone and ignored userId, so it
      // leaked every user's private commands in a shared workspace.
      const access = AccessContext.agent({ userId: input.userId }).withLens(
        input.workspaceId
      );
      const rows = await scopedDb(access).findMany<{
        id: string;
        title: string;
        promptTemplate: string;
        derivedInputs: unknown;
        inputOverrides: unknown;
        allowedTools: unknown;
        outputMode: string;
        permissionsProfile: string;
        sharedScope: string;
        createdAt: Date;
      }>(intelligenceCommands, {
        columns: {
          id: true,
          title: true,
          promptTemplate: true,
          derivedInputs: true,
          inputOverrides: true,
          allowedTools: true,
          outputMode: true,
          permissionsProfile: true,
          sharedScope: true,
          createdAt: true,
        },
        orderBy: [desc(intelligenceCommands.updatedAt)],
        limit: input.limit ?? 50,
      });

      return { commands: rows };
    }),

  /**
   * Get a single command by ID.
   * Requires: hub-protocol.read scope
   */
  getCommand: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        id: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      // Same sharedScope floor on the acting user: a non-visible id (another
      // user's private command, or a command outside the lensed workspace)
      // resolves to undefined → not found.
      const access = AccessContext.agent({ userId: input.userId }).withLens(
        input.workspaceId
      );
      const row = await scopedDb(access).findFirst<
        typeof intelligenceCommands.$inferSelect
      >(intelligenceCommands, {
        where: eq(intelligenceCommands.id, input.id),
      });

      if (!row) {
        throw new Error("Command not found");
      }
      return row;
    }),
});
