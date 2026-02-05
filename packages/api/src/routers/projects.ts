/**
 * Projects Router - Project Management (Now Using Entities)
 *
 * Projects are now entities with profileSlug="project".
 * This router provides a convenient API for project operations.
 * All write operations use event-driven architecture.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  entities,
  eq,
  desc,
  and,
  getDb,
  ProfileResolutionService,
} from "@synap/database";
import { emitRequestEvent } from "../utils/emit-event.js";
import { TRPCError } from "@trpc/server";

export const projectsRouter = router({
  /**
   * List all projects for the current user
   * Projects are entities with type="project"
   */
  list: workspaceProcedure
    .input(
      z
        .object({
          status: z.enum(["active", "archived", "completed"]).optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // Get project profile
      const projectProfile = await resolutionService.resolveProfile(
        "project",
        ctx.userId,
        ctx.workspaceId
      );

      if (!projectProfile) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Project profile not found. Please run seed-profiles script.",
        });
      }

      const conditions: any[] = [
        eq(entities.workspaceId, ctx.workspaceId),
        eq(entities.userId, ctx.userId),
        eq(entities.profileId, projectProfile.id),
      ];

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: input?.limit || 50,
        offset: input?.offset || 0,
      });

      // Filter by status if provided (from properties)
      let filtered = results;
      if (input?.status) {
        filtered = results.filter((entity) => {
          const props = entity.properties as Record<string, unknown>;
          return props?.status === input.status;
        });
      }

      // Transform to project-like format for backward compatibility
      const projects = filtered.map((entity) => ({
        id: entity.id,
        name: entity.title || "Untitled",
        description: entity.preview || null,
        status:
          ((entity.properties as Record<string, unknown>)?.status as string) ||
          "active",
        settings:
          ((entity.properties as Record<string, unknown>)?.settings as Record<
            string,
            unknown
          >) || {},
        metadata:
          ((entity.properties as Record<string, unknown>)?.metadata as Record<
            string,
            unknown
          >) || {},
        userId: entity.userId,
        workspaceId: entity.workspaceId,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
      }));

      return { projects };
    }),

  /**
   * Get a single project by ID
   */
  get: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      // Get project profile
      const projectProfile = await resolutionService.resolveProfile(
        "project",
        ctx.userId,
        ctx.workspaceId
      );

      if (!projectProfile) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Project profile not found. Please run seed-profiles script.",
        });
      }

      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId),
          eq(entities.workspaceId, ctx.workspaceId),
          eq(entities.profileId, projectProfile.id)
        ),
      });

      if (!entity) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Transform to project-like format
      const project = {
        id: entity.id,
        name: entity.title || "Untitled",
        description: entity.preview || null,
        status:
          ((entity.properties as Record<string, unknown>)?.status as string) ||
          "active",
        settings:
          ((entity.properties as Record<string, unknown>)?.settings as Record<
            string,
            unknown
          >) || {},
        metadata:
          ((entity.properties as Record<string, unknown>)?.metadata as Record<
            string,
            unknown
          >) || {},
        userId: entity.userId,
        workspaceId: entity.workspaceId,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
      };

      return { project };
    }),

  /**
   * Create a new project
   * Event-driven: emits entities.create.requested (with profileSlug="project")
   */
  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        status: z.enum(["active", "archived", "completed"]).default("active"),
        settings: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { randomUUID } = await import("crypto");
      const projectId = randomUUID();

      // Build properties object
      const properties: Record<string, unknown> = {
        status: input.status,
      };
      if (input.description) {
        properties.description = input.description;
      }
      if (input.settings) {
        properties.settings = input.settings;
      }
      if (input.metadata) {
        properties.metadata = input.metadata;
      }

      await emitRequestEvent({
        subjectType: "entity",
        action: "create",
        subjectId: projectId,
        data: {
          id: projectId,
          profileSlug: "project",
          title: input.name,
          preview: input.description,
          properties,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested", projectId };
    }),

  /**
   * Update an existing project
   * Event-driven: emits entities.update.requested
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        status: z.enum(["active", "archived", "completed"]).optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Get current entity to merge properties
      const db = await getDb();
      const resolutionService = new ProfileResolutionService(db);

      const projectProfile = await resolutionService.resolveProfile(
        "project",
        ctx.userId,
        ctx.workspaceId
      );

      if (!projectProfile) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Project profile not found",
        });
      }

      const current = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.id),
          eq(entities.userId, ctx.userId),
          eq(entities.workspaceId, ctx.workspaceId),
          eq(entities.profileId, projectProfile.id)
        ),
      });

      if (!current) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      // Merge properties
      const currentProperties =
        (current.properties as Record<string, unknown>) || {};
      const updatedProperties: Record<string, unknown> = {
        ...currentProperties,
      };

      if (input.status !== undefined) {
        updatedProperties.status = input.status;
      }
      if (input.settings !== undefined) {
        updatedProperties.settings = input.settings;
      }
      if (input.metadata !== undefined) {
        updatedProperties.metadata = input.metadata;
      }

      await emitRequestEvent({
        subjectType: "entity",
        action: "update",
        subjectId: input.id,
        data: {
          id: input.id,
          title: input.name,
          preview: input.description,
          properties: updatedProperties,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested" };
    }),

  /**
   * Delete a project
   * Event-driven: emits entities.delete.requested
   */
  delete: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        subjectType: "entity",
        action: "delete",
        subjectId: input.id,
        data: {
          id: input.id,
          userId: ctx.userId,
        },
        userId: ctx.userId,
      });

      return { status: "requested" };
    }),
});
