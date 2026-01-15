/**
 * Projects Router - Project Management
 *
 * Handles user projects for organizing threads and entities.
 * All write operations use event-driven architecture.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, projects, eq, desc, and } from "@synap/database";
import { emitRequestEvent } from "../utils/emit-event.js";

export const projectsRouter = router({
  /**
   * List all projects for the current user
   */
  list: protectedProcedure
    .input(
      z
        .object({
          status: z.enum(["active", "archived", "completed"]).optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const conditions = [eq(projects.userId, ctx.userId)];

      if (input?.status) {
        conditions.push(eq(projects.status, input.status));
      }

      const results = await ctx.db.query.projects.findMany({
        where: and(...conditions),
        orderBy: [desc(projects.createdAt)],
        limit: input?.limit || 50,
        offset: input?.offset || 0,
      });

      return { projects: results };
    }),

  /**
   * Get a single project by ID
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const project = await ctx.db.query.projects.findFirst({
        where: and(
          eq(projects.id, input.id),
          eq(projects.userId, ctx.userId)
        ),
      });

      if (!project) {
        throw new Error("Project not found");
      }

      return { project };
    }),

  /**
   * Create a new project
   * Event-driven: emits projects.create.requested
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        status: z.enum(["active", "archived", "completed"]).default("active"),
        settings: z.record(z.unknown()).optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { randomUUID } = await import("crypto");
      const projectId = randomUUID();

      await emitRequestEvent({
        eventRepo: ctx.eventRepo,
        inngest: ctx.inngest,
        type: "projects.create.requested",
        subjectId: projectId,
        subjectType: "project",
        data: {
          id: projectId,
          name: input.name,
          description: input.description,
          status: input.status,
          settings: input.settings,
          metadata: input.metadata,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested", projectId };
    }),

  /**
   * Update an existing project
   * Event-driven: emits projects.update.requested
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        status: z.enum(["active", "archived", "completed"]).optional(),
        settings: z.record(z.unknown()).optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        eventRepo: ctx.eventRepo,
        inngest: ctx.inngest,
        type: "projects.update.requested",
        subjectId: input.id,
        subjectType: "project",
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          status: input.status,
          settings: input.settings,
          metadata: input.metadata,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested" };
    }),

  /**
   * Delete a project
   * Event-driven: emits projects.delete.requested
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        eventRepo: ctx.eventRepo,
        inngest: ctx.inngest,
        type: "projects.delete.requested",
        subjectId: input.id,
        subjectType: "project",
        data: {
          id: input.id,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested" };
    }),

  /**
   * List project members
   */
  listMembers: protectedProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { projectMembers, eq } = await import("@synap/database");
      
      // TODO: Check if user has access to this project
      const members = await ctx.db.query.projectMembers.findMany({
        where: eq(projectMembers.projectId, input.projectId),
      });

      return { members };
    }),

  /**
   * Add member to project
   * Event-driven: emits projectMembers.add.requested
   */
  addMember: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        userId: z.string(),
        role: z.enum(['owner', 'editor', 'viewer']),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        eventRepo: ctx.eventRepo,
        inngest: ctx.inngest,
        type: "projectMembers.add.requested",
        subjectId: input.projectId,
        subjectType: "project",
        data: {
          projectId: input.projectId,
          targetUserId: input.userId,
          role: input.role,
          invitedBy: ctx.userId,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Project member addition requested",
      };
    }),

  /**
   * Remove member from project
   * Event-driven: emits projectMembers.remove.requested
   */
  removeMember: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        userId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        eventRepo: ctx.eventRepo,
        inngest: ctx.inngest,
        type: "projectMembers.remove.requested",
        subjectId: input.projectId,
        subjectType: "project",
        data: {
          projectId: input.projectId,
          targetUserId: input.userId,
          removedBy: ctx.userId,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Project member removal requested",
      };
    }),

  /**
   * Update member role in project
   * Event-driven: emits projectMembers.updateRole.requested
   */
  updateMemberRole: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        userId: z.string(),
        role: z.enum(['owner', 'editor', 'viewer']),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        eventRepo: ctx.eventRepo,
        inngest: ctx.inngest,
        type: "projectMembers.updateRole.requested",
        subjectId: input.projectId,
        subjectType: "project",
        data: {
          projectId: input.projectId,
          targetUserId: input.userId,
          newRole: input.role,
          updatedBy: ctx.userId,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Project member role update requested",
      };
    }),
});
