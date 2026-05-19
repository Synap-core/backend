/**
 * Roles Router - Custom Role Management (RBAC + ABAC)
 *
 * Synchronous CRUD with inline permission checks.
 * Supports workspace-scoped and global roles.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  isNull,
  getDb,
  EventRepository,
  RoleRepository,
  sql,
} from "@synap/database";
import { roles } from "@synap/database/schema";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { randomUUID } from "crypto";

export const rolesRouter = router({
  /**
   * List roles (workspace-scoped or global)
   */
  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
        })
        .optional()
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
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Role not found",
        });
      }

      return role;
    }),

  /**
   * Create a new role
   */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
        permissions: z.record(z.string(), z.any()),
        filters: z.record(z.string(), z.any()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "role",
        action: "create",
        data: { id, name: input.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const roleRepo = new RoleRepository(database, eventRepo);

      const role = await roleRepo.create(
        {
          name: input.name,
          description: input.description,
          workspaceId: input.workspaceId,
          permissions: input.permissions,
          filters: input.filters,
          createdBy: ctx.userId,
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "role",
        action: "create",
        phase: "completed",
        subjectId: role.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { name: input.name },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "role",
        action: "create",
        subjectId: role.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: role.id,
        status: "created" as const,
      };
    }),

  /**
   * Update a role
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        permissions: z.record(z.string(), z.any()).optional(),
        filters: z.record(z.string(), z.any()).optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "role",
        action: "update",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const roleRepo = new RoleRepository(database, eventRepo);

      await roleRepo.update(
        input.id,
        {
          name: input.name,
          description: input.description,
          permissions: input.permissions,
          filters: input.filters,
        },
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "role",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { name: input.name },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "role",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        status: "updated" as const,
      };
    }),

  /**
   * Delete a role
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "role",
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
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const roleRepo = new RoleRepository(database, eventRepo);

      await roleRepo.delete(input.id, ctx.userId);

      // 3. Audit log
      auditLog({
        subjectType: "role",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "role",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        status: "deleted" as const,
      };
    }),
});
