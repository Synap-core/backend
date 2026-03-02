/**
 * Agent Configs Router
 *
 * Centralised CRUD for per-user agent configuration overrides.
 * Moved here from the Intelligence Hub's local storage so any
 * intelligence service can read user preferences via Hub Protocol.
 *
 * agent_type is a free-form string defined by each intelligence service.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and } from "@synap/database";
import { agentConfigs } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";

const AgentConfigInputSchema = z.object({
  promptAppend: z.string().nullable().optional(),
  extraToolIds: z.array(z.string()).optional(),
  disabledToolIds: z.array(z.string()).optional(),
  maxStepsOverride: z.number().int().positive().nullable().optional(),
  modelOverride: z.string().nullable().optional(),
});

export const agentConfigsRouter = router({
  /**
   * List all agent configs for the current user in this workspace.
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const userId = requireUserId(ctx.userId);
    const configs = await db.query.agentConfigs.findMany({
      where: and(
        eq(agentConfigs.userId, userId),
        eq(agentConfigs.workspaceId, ctx.workspaceId!)
      ),
    });
    return { configs };
  }),

  /**
   * Get one agent config. Returns null config if not yet customised.
   */
  get: workspaceProcedure
    .input(z.object({ agentType: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const config = await db.query.agentConfigs.findFirst({
        where: and(
          eq(agentConfigs.userId, userId),
          eq(agentConfigs.workspaceId, ctx.workspaceId!),
          eq(agentConfigs.agentType, input.agentType)
        ),
      });
      return { config: config ?? null };
    }),

  /**
   * Create or update an agent config (upsert on userId + workspaceId + agentType).
   */
  upsert: workspaceProcedure
    .input(
      z.object({
        agentType: z.string().min(1),
        ...AgentConfigInputSchema.shape,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { agentType, ...fields } = input;

      const [config] = await db
        .insert(agentConfigs)
        .values({
          userId,
          workspaceId: ctx.workspaceId!,
          agentType,
          promptAppend: fields.promptAppend ?? null,
          extraToolIds: fields.extraToolIds ?? [],
          disabledToolIds: fields.disabledToolIds ?? [],
          maxStepsOverride: fields.maxStepsOverride ?? null,
          modelOverride: fields.modelOverride ?? null,
        })
        .onConflictDoUpdate({
          target: [
            agentConfigs.userId,
            agentConfigs.workspaceId,
            agentConfigs.agentType,
          ],
          set: {
            promptAppend:
              fields.promptAppend !== undefined
                ? fields.promptAppend
                : agentConfigs.promptAppend,
            extraToolIds: fields.extraToolIds ?? agentConfigs.extraToolIds,
            disabledToolIds:
              fields.disabledToolIds ?? agentConfigs.disabledToolIds,
            maxStepsOverride:
              fields.maxStepsOverride !== undefined
                ? fields.maxStepsOverride
                : agentConfigs.maxStepsOverride,
            modelOverride:
              fields.modelOverride !== undefined
                ? fields.modelOverride
                : agentConfigs.modelOverride,
            updatedAt: new Date(),
          },
        })
        .returning();

      return { config };
    }),

  /**
   * Delete an agent config, resetting the agent to its service defaults.
   */
  delete: workspaceProcedure
    .input(z.object({ agentType: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const existing = await db.query.agentConfigs.findFirst({
        where: and(
          eq(agentConfigs.userId, userId),
          eq(agentConfigs.workspaceId, ctx.workspaceId!),
          eq(agentConfigs.agentType, input.agentType)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No config found for agent type: ${input.agentType}`,
        });
      }

      await db
        .delete(agentConfigs)
        .where(
          and(
            eq(agentConfigs.userId, userId),
            eq(agentConfigs.workspaceId, ctx.workspaceId!),
            eq(agentConfigs.agentType, input.agentType)
          )
        );

      return { success: true };
    }),
});
