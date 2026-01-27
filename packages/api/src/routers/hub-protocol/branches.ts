/**
 * Hub Protocol - Branches Router
 *
 * Handles branch operations (create, merge)
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { db, eq } from "@synap/database";
import { chatThreads } from "@synap/database/schema";

export const branchesRouter = router({
  /**
   * Create branch thread
   * Requires: hub-protocol.write scope
   */
  createBranch: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        parentThreadId: z.string().uuid(),
        branchPurpose: z.string(),
        agentId: z.string().optional(),
        agentType: z
          .enum([
            "default",
            "meta",
            "prompting",
            "knowledge-search",
            "code",
            "writing",
            "action",
          ])
          .optional(),
        agentConfig: z.record(z.string(), z.unknown()).optional(),
        inheritContext: z.boolean().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const { emitRequestEvent } = await import("../../utils/emit-event.js");
      const { randomUUID } = await import("crypto");

      const threadId = randomUUID();

      // Get workspaceId from parent thread
      const parentThread = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.parentThreadId),
      });

      if (!parentThread) {
        throw new Error("Parent thread not found");
      }

      await emitRequestEvent({
        type: "chat_threads.branch.requested",
        subjectId: input.parentThreadId,
        subjectType: "chat_thread",
        data: {
          id: threadId,
          userId: input.userId,
          projectId: parentThread.projectId || undefined,
          parentThreadId: input.parentThreadId,
          branchPurpose: input.branchPurpose,
          agentId: input.agentId,
          agentType: input.agentType,
          agentConfig: input.agentConfig,
          inheritContext: input.inheritContext,
        },
        userId: input.userId,
        workspaceId: parentThread.projectId || undefined,
      });

      return {
        status: "requested",
        threadId,
        message: "Branch creation requested",
      };
    }),

  /**
   * Merge branch thread
   * Requires: hub-protocol.write scope
   */
  mergeBranch: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        branchId: z.string().uuid(),
        summary: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { emitRequestEvent } = await import("../../utils/emit-event.js");

      const branch = await db.query.chatThreads.findFirst({
        where: eq(chatThreads.id, input.branchId),
      });

      if (!branch || branch.threadType !== "branch") {
        throw new Error("Branch not found");
      }

      if (!branch.parentThreadId) {
        throw new Error("Branch has no parent thread");
      }

      await emitRequestEvent({
        type: "chat_threads.merge.requested",
        subjectId: input.branchId,
        subjectType: "chat_thread",
        data: {
          branchId: input.branchId,
          parentThreadId: branch.parentThreadId,
          summary: input.summary,
          userId: input.userId,
        },
        userId: input.userId,
        workspaceId: branch.projectId || undefined,
      });

      return {
        status: "requested",
        message: "Branch merge requested",
      };
    }),
});
