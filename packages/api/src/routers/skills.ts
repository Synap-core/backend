/**
 * Skills Router
 *
 * Synchronous CRUD operations for user-created skills.
 * Direct DB operations with inline permission checks.
 * Skills are stored in the backend, executed in the Intelligence Service.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, desc } from "@synap/database";
import { skills } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { randomUUID } from "crypto";

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
      const skillId = randomUUID();

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: input.workspaceId,
        subjectType: "skill",
        action: "create",
        data: { id: skillId, name: input.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { id: skillId, status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const [skill] = await db
        .insert(skills)
        .values({
          id: skillId,
          userId,
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          code: input.code,
          parameters: input.parameters || {},
          category: input.category,
          executionMode: input.executionMode,
          timeoutSeconds: input.timeoutSeconds,
          status: "active",
        })
        .returning();

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "create",
        phase: "completed",
        subjectId: skill.id,
        userId,
        workspaceId: input.workspaceId,
        data: { name: input.name },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "create",
        subjectId: skill.id,
        userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: skill.id,
        status: "created" as const,
      };
    }),

  /**
   * Update a skill
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

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        subjectType: "skill",
        action: "update",
        data: { id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const [_updated] = await db
        .update(skills)
        .set({
          ...updateData,
          updatedAt: new Date(),
        })
        .where(and(eq(skills.id, id), eq(skills.userId, userId)))
        .returning();

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "update",
        phase: "completed",
        subjectId: id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        data: updateData,
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "update",
        subjectId: id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
      });

      return {
        status: "updated" as const,
      };
    }),

  /**
   * Delete a skill
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

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        subjectType: "skill",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      await db
        .delete(skills)
        .where(and(eq(skills.id, input.id), eq(skills.userId, userId)));

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "delete",
        subjectId: input.id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
      });

      return {
        status: "deleted" as const,
      };
    }),
});
