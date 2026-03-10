/**
 * Hub Protocol - Commands Router
 *
 * Exposes intelligence commands to the IS so AI can discover
 * available commands when building automations.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { createHubProtocolCallerContext } from "./utils.js";
import { db, intelligenceCommands, eq, and, desc } from "@synap/database";

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
      const rows = await db
        .select({
          id: intelligenceCommands.id,
          title: intelligenceCommands.title,
          promptTemplate: intelligenceCommands.promptTemplate,
          derivedInputs: intelligenceCommands.derivedInputs,
          inputOverrides: intelligenceCommands.inputOverrides,
          allowedTools: intelligenceCommands.allowedTools,
          outputMode: intelligenceCommands.outputMode,
          permissionsProfile: intelligenceCommands.permissionsProfile,
          sharedScope: intelligenceCommands.sharedScope,
          createdAt: intelligenceCommands.createdAt,
        })
        .from(intelligenceCommands)
        .where(eq(intelligenceCommands.workspaceId, input.workspaceId))
        .orderBy(desc(intelligenceCommands.updatedAt))
        .limit(input.limit ?? 50);

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
      const row = await db.query.intelligenceCommands.findFirst({
        where: and(
          eq(intelligenceCommands.id, input.id),
          eq(intelligenceCommands.workspaceId, input.workspaceId)
        ),
      });

      if (!row) {
        throw new Error("Command not found");
      }
      return row;
    }),
});
