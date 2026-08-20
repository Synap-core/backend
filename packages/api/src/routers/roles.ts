/**
 * Roles Router - Custom Role Management (RBAC + ABAC)
 *
 * Synchronous CRUD with inline permission checks.
 * Supports workspace-scoped and global roles.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { AccessContext, scopedDb } from "../access/index.js";
import { TRPCError } from "@trpc/server";
import {
  eq,
  isNull,
  getDb,
  EventRepository,
  RoleRepository,
  sql,
} from "@synap/database";
import { roles } from "@synap/database/schema";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { recordDomainMutation } from "../utils/domain-mutation.js";
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
    .query(async ({ input, ctx }) => {
      // scopedDb auto-ANDs the membership predicate: workspace roles are only
      // returned to members; the global branch (workspaceId IS NULL) is pod-wide.
      const sdb = scopedDb(AccessContext.from(ctx));
      return sdb.findMany<typeof roles.$inferSelect>(roles, {
        where: input?.workspaceId
          ? eq(roles.workspaceId, input.workspaceId)
          : isNull(roles.workspaceId),
      });
    }),

  /**
   * Get a single role by ID
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      // scopedDb auto-ANDs the membership predicate — a non-member can't read
      // another workspace's role (incl. its RBAC permission/filter config).
      const role = await scopedDb(AccessContext.from(ctx)).findFirst<
        typeof roles.$inferSelect
      >(roles, { where: eq(roles.id, input.id) });

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
        // Widened (gate-payload sufficiency): `{ id, name }` LOST `permissions`
        // — a required, non-defaultable input — so an approved role proposal
        // could never materialize a role that grants anything. Carry the FULL
        // insert shape (exactly what `roleRepo.create` reads below) so the
        // approve-executor can replay this procedure verbatim. `permissions`/
        // `filters` are RBAC CONFIG, not secrets: showing them in the review UI
        // is the point — approving a role IS approving its grants. Only the
        // PROPOSED row's stored data widens; the granted path below is untouched.
        data: {
          id,
          name: input.name,
          description: input.description,
          workspaceId: input.workspaceId,
          permissions: input.permissions,
          filters: input.filters,
        },
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

      // 3. Log + side-effects — ONE door (recordDomainMutation).
      void recordDomainMutation({
        subjectType: "role",
        action: "create",
        subjectId: role.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        logData: { name: input.name },
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
        // Widened (gate-payload sufficiency): `{ id }` alone described NO change
        // — an approved update proposal had nothing to apply. Carry the same
        // patch fields `roleRepo.update` reads below. `permissions`/`filters` are
        // RBAC config, not secrets (see `create`). `undefined` keys drop out at
        // JSON-serialization, so an omitted field stays omitted on replay.
        data: {
          id: input.id,
          name: input.name,
          description: input.description,
          permissions: input.permissions,
          filters: input.filters,
          workspaceId: input.workspaceId,
        },
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

      // Gate on the ROLE's real workspace — the permission check above keys off
      // the request workspaceId, which does NOT pin the role row to a workspace
      // the caller belongs to.
      const roleRow = await scopedDb(AccessContext.from(ctx)).findFirst<{
        workspaceId: string | null;
      }>(roles, {
        where: eq(roles.id, input.id),
        columns: { workspaceId: true },
      });
      if (!roleRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Role not found" });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: roleRow.workspaceId,
      });

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

      // 3. Log + side-effects — ONE door (recordDomainMutation).
      void recordDomainMutation({
        subjectType: "role",
        action: "update",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        logData: { name: input.name },
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

      // Gate on the ROLE's real workspace (see update — request workspaceId
      // doesn't pin the row).
      const roleRow = await scopedDb(AccessContext.from(ctx)).findFirst<{
        workspaceId: string | null;
      }>(roles, {
        where: eq(roles.id, input.id),
        columns: { workspaceId: true },
      });
      if (!roleRow) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Role not found" });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: roleRow.workspaceId,
      });

      await roleRepo.delete(input.id, ctx.userId);

      // 3. Log + side-effects — ONE door (recordDomainMutation).
      void recordDomainMutation({
        subjectType: "role",
        action: "delete",
        subjectId: input.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        logData: { id: input.id },
      });

      return {
        status: "deleted" as const,
      };
    }),
});
