/**
 * Roles Router - Custom Role Management (RBAC + ABAC)
 *
 * Handles custom role CRUD with event-driven architecture.
 * Supports workspace-scoped and global roles.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, isNull, roles } from "@synap/database";
import { emitRequestEvent } from "../utils/emit-event.js";
import { randomUUID } from "crypto";

export const rolesRouter = router({
  /**
   * List roles (workspace-scoped or global)
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
      }).optional(),
    )
    .query(async ({ input }) => {
      if (input?.workspaceId) {
        // Workspace-scoped roles
        return db.query.roles.findMany({
          where: eq(roles.workspaceId, input.workspaceId),
        });
      } else {
        // Global roles
        return db.query.roles.findMany({
          where: isNull(roles.workspaceId),
        });
      }
    }),

  /**
   * Get a single role by ID
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const role = await db.query.roles.findFirst({
        where: eq(roles.id, input.id),
      });

      if (!role) {
        throw new Error("Role not found");
      }

      return role;
    }),

  /**
   * Create a new role
   * Event-driven: emits roles.create.requested
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
        permissions: z.record(z.any()),
        filters: z.record(z.any()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();

      await emitRequestEvent({
        type: "roles.create.requested",
        subjectId: id,
        subjectType: "role",
        data: {
          id,
          name: input.name,
          description: input.description,
          workspaceId: input.workspaceId,
          permissions: input.permissions,
          filters: input.filters,
          createdBy: ctx.userId,
        },
        userId: ctx.userId,
      });

      return {
        id,
        status: "requested",
        message: "Role creation requested",
      };
    }),

  /**
   * Update a role
   * Event-driven: emits roles.update.requested
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        permissions: z.record(z.any()).optional(),
        filters: z.record(z.any()).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        type: "roles.update.requested",
        subjectId: input.id,
        subjectType: "role",
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          permissions: input.permissions,
          filters: input.filters,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Role update requested",
      };
    }),

  /**
   * Delete a role
   * Event-driven: emits roles.delete.requested
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await emitRequestEvent({
        type: "roles.delete.requested",
        subjectId: input.id,
        subjectType: "role",
        data: {
          id: input.id,
        },
        userId: ctx.userId,
      });

      return {
        status: "requested",
        message: "Role deletion requested",
      };
    }),
});
