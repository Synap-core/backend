/**
 * Projects Router - Project Management (Now Using Entities)
 *
 * Projects are now entities with profileSlug="project".
 * Synchronous CRUD with direct DB operations.
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
  EventRepository,
  EntityRepository,
  sql,
  drizzleSql,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";

export const projectsRouter = router({
  /**
   * List all projects for the current user
   */
  list: workspaceProcedure
    .input(
      paginatedInput
        .extend({
          status: z.enum(["active", "archived", "completed"]).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
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
          message:
            "Project profile not found. Please run seed-profiles script.",
        });
      }

      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const conditions: any[] = [
        eq(entities.workspaceId, ctx.workspaceId),
        eq(entities.userId, ctx.userId),
        eq(entities.profileId, projectProfile.id),
      ];

      // Filter by status in SQL using JSONB operator (was post-query filtering)
      if (input?.status) {
        conditions.push(
          drizzleSql`${entities.properties}->>'status' = ${input.status}`
        );
      }

      const results = await db.query.entities.findMany({
        where: and(...conditions),
        orderBy: [desc(entities.createdAt)],
        limit: limit + 1,
        offset,
      });

      const { items: resultItems, pagination } = buildPaginatedResponse(
        results,
        { limit, offset }
      );

      const projects = resultItems.map((entity) => ({
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

      return {
        items: projects,
        pagination,
        /** @deprecated Use `items` instead */
        projects,
      };
    }),

  /**
   * Get a single project by ID
   */
  get: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
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
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "create",
        data: { profileSlug: "project", title: input.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed",
          projectId: "",
          proposalId: perm.proposalId,
        };
      }

      const properties: Record<string, unknown> = { status: input.status };
      if (input.description) properties.description = input.description;
      if (input.settings) properties.settings = input.settings;
      if (input.metadata) properties.metadata = input.metadata;

      const db = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(db, eventRepo);

      const created = await entityRepo.create(
        {
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          title: input.name,
          preview: input.description || undefined,
          properties,
          profileSlug: "project",
        },
        ctx.userId
      );

      auditLog({
        subjectType: "entity",
        action: "create",
        phase: "completed",
        subjectId: created.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { profileSlug: "project" },
      });

      emitSideEffects({
        subjectType: "entity",
        action: "create",
        subjectId: created.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "created", projectId: created.id };
    }),

  /**
   * Update an existing project
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
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "update",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed", proposalId: perm.proposalId };
      }

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

      const currentProperties =
        (current.properties as Record<string, unknown>) || {};
      const updatedProperties: Record<string, unknown> = {
        ...currentProperties,
      };

      if (input.status !== undefined) updatedProperties.status = input.status;
      if (input.settings !== undefined)
        updatedProperties.settings = input.settings;
      if (input.metadata !== undefined)
        updatedProperties.metadata = input.metadata;

      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(db, eventRepo);

      await entityRepo.update(
        input.id,
        {
          title: input.name || undefined,
          preview: input.description || undefined,
          properties: updatedProperties,
        },
        ctx.userId
      );

      auditLog({
        subjectType: "entity",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "entity",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "updated" };
    }),

  /**
   * Delete a project
   */
  delete: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "entity",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed", proposalId: perm.proposalId };
      }

      const db = await getDb();
      const eventRepo = new EventRepository(sql);
      const entityRepo = new EntityRepository(db, eventRepo);

      await entityRepo.delete(input.id, ctx.userId);

      auditLog({
        subjectType: "entity",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "entity",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "deleted" };
    }),
});
