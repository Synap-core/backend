/**
 * Skills Router
 *
 * Handles CRUD operations for user-created skills.
 * Skills are stored in the backend, executed in the Intelligence Service.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { skills, eq, and, desc } from "@synap/database";
import { requireUserId } from "../utils/user-scoped.js";
import { emitRequestEvent } from "../utils/emit-event.js";

export const skillsRouter = router({
  /**
   * List skills for the current user
   */
  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
          status: z.enum(["active", "inactive", "error", "all"]).optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const conditions = [eq(skills.userId, userId)];

      if (input?.workspaceId) {
        conditions.push(eq(skills.workspaceId, input.workspaceId));
      }

      if (input?.status && input.status !== "all") {
        conditions.push(eq(skills.status, input.status));
      }

      const results = await ctx.db.query.skills.findMany({
        where: and(...conditions),
        orderBy: [desc(skills.createdAt)],
        limit: input?.limit || 50,
        offset: input?.offset || 0,
      });

      return { skills: results };
    }),

  /**
   * Get a single skill by ID
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await ctx.db.query.skills.findFirst({
        where: and(eq(skills.id, input.id), eq(skills.userId, userId)),
      });

      if (!skill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      return { skill };
    }),

  /**
   * Create a new skill
   * Event-driven: emits skills.create.requested
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        code: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).default("sync"),
        timeoutSeconds: z.number().min(1).max(300).default(30),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { randomUUID } = await import("crypto");
      const skillId = randomUUID();

      // Emit event for skill creation
      await emitRequestEvent({
        type: "skills.create.requested",
        subjectId: skillId,
        subjectType: "skill",
        data: {
          id: skillId,
          userId,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          code: input.code,
          parameters: input.parameters,
          category: input.category,
          executionMode: input.executionMode,
          timeoutSeconds: input.timeoutSeconds,
        },
        userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: skillId,
        success: true,
        message: "Skill creation requested",
      };
    }),

  /**
   * Update a skill
   * Event-driven: emits skills.update.requested
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        code: z.string().min(1).optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).optional(),
        timeoutSeconds: z.number().min(1).max(300).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { id, ...updateData } = input;

      // Verify skill exists and belongs to user
      const existingSkill = await ctx.db.query.skills.findFirst({
        where: and(eq(skills.id, id), eq(skills.userId, userId)),
      });

      if (!existingSkill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      // Emit event for skill update
      await emitRequestEvent({
        type: "skills.update.requested",
        subjectId: id,
        subjectType: "skill",
        data: {
          skillId: id,
          ...updateData,
        },
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
      });

      return {
        success: true,
        message: "Skill update requested",
      };
    }),

  /**
   * Delete a skill
   * Event-driven: emits skills.delete.requested
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Verify skill exists and belongs to user
      const existingSkill = await ctx.db.query.skills.findFirst({
        where: and(eq(skills.id, input.id), eq(skills.userId, userId)),
      });

      if (!existingSkill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      // Emit event for skill deletion
      await emitRequestEvent({
        type: "skills.delete.requested",
        subjectId: input.id,
        subjectType: "skill",
        data: {
          skillId: input.id,
        },
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
      });

      return {
        success: true,
        message: "Skill deletion requested",
      };
    }),
});
