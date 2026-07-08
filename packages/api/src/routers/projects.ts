/**
 * Projects Router — Project Management (projects TABLE)
 *
 * Projects are first-class table rows in the `projects` pgTable — NOT entities.
 * Synchronous CRUD with ProjectRepository + direct table queries.
 */

import { z } from "zod";
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import {
  projects,
  eq,
  desc,
  and,
  or,
  isNull,
  isNotNull,
  getDb,
  EventRepository,
  sql,
  ProjectRepository,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
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

      const limit = input?.limit ?? 50;
      const offset = input?.offset ?? 0;

      const conditions: ReturnType<typeof eq>[] = [
        or(
          // Pod-wide projects (NULL workspace): only visible to their owner
          and(isNull(projects.workspaceId), eq(projects.userId, ctx.userId)),
          // Workspace-scoped projects: visible to all workspace members
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, ctx.userId)
          )
        )!,
      ];

      if (input?.status) {
        conditions.push(eq(projects.status, input.status));
      }

      const results = await db
        .select()
        .from(projects)
        .where(and(...conditions))
        .orderBy(desc(projects.createdAt))
        .limit(limit + 1)
        .offset(offset);

      const { items, pagination } = buildPaginatedResponse(results, {
        limit,
        offset,
      });

      return {
        items,
        pagination,
        /** @deprecated Use `items` instead */
        projects: items,
      };
    }),

  /**
   * Get a single project by ID
   */
  get: podProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Single-object read: the WHERE is already pure user-floor (pod-personal
      // owner OR workspace-member visibility). It must not be gated by the
      // active-workspace lens, so it runs on podProcedure, not workspaceProcedure.
      const db = await getDb();

      const project = await db.query.projects.findFirst({
        where: and(
          eq(projects.id, input.id),
          or(
            and(isNull(projects.workspaceId), eq(projects.userId, ctx.userId)),
            and(
              isNotNull(projects.workspaceId),
              userVisibleWhere(projects.workspaceId, ctx.userId)
            )
          )!
        ),
      });

      if (!project) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

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
        subjectType: "project",
        action: "create",
        data: { name: input.name },
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

      const db = await getDb();
      const eventRepo = new EventRepository(sql);
      const projectRepo = new ProjectRepository(db, eventRepo);

      const created = await projectRepo.create(
        {
          name: input.name,
          description: input.description,
          status: input.status,
          settings: input.settings,
          metadata: input.metadata,
          userId: ctx.userId,
          workspaceId: ctx.workspaceId ?? null,
        },
        ctx.userId
      );

      auditLog({
        subjectType: "project",
        action: "create",
        phase: "completed",
        subjectId: created.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "project",
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
        subjectType: "project",
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
      const eventRepo = new EventRepository(sql);
      const projectRepo = new ProjectRepository(db, eventRepo);

      await projectRepo.update(input.id, input, ctx.userId);

      auditLog({
        subjectType: "project",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "project",
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
        subjectType: "project",
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
      const projectRepo = new ProjectRepository(db, eventRepo);

      await projectRepo.delete(input.id, ctx.userId);

      auditLog({
        subjectType: "project",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      emitSideEffects({
        subjectType: "project",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "deleted" };
    }),
});
