/**
 * tRPC Initialization - CQRS API Layer
 *
 * Security Model:
 * - Authentication: Ory Kratos session validation
 * - Authorization: Worker-based permissions (permissionValidator)
 * - Database Queries: Explicit userId filters
 *
 * Commands publish events → Workers validate permissions → DB operations
 */

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context.js";
import { requireUserId } from "./utils/user-scoped.js";
import { createLogger } from "@synap-core/core";
import { db, eq, and, drizzleSql, inArray } from "@synap/database";
import { workspaceMembers, workspaces } from "@synap/database/schema";
import "@synap/database"; // Fix TS2742: inferred type portability

const logger = createLogger({ module: "trpc" });

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

/**
 * Public procedure (no auth required)
 */
export const publicProcedure = t.procedure as typeof t.procedure;

/**
 * Protected procedure (auth required)
 *
 * Validates Ory Kratos session. Authorization handled by permissionValidator worker.
 */
export const protectedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;

  if (!ctx.authenticated) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }

  const userId = requireUserId(ctx.userId);

  logger.debug({ userId }, "Protected procedure - authentication validated");

  return opts.next({
    ctx: {
      ...ctx,
      userId, // Ensure userId is always a string in protected procedures
    },
  });
});

/**
 * Workspace-scoped procedure (auth + workspace required)
 *
 * Automatically validates workspace membership and adds workspaceId to context.
 * All procedures using this will automatically have workspace scoping.
 *
 * Requirements:
 * - User must be authenticated (extends protectedProcedure)
 * - X-Workspace-Id header must be present in request
 * - User must be a member of the workspace
 *
 * After this middleware, ctx.workspaceId and ctx.workspaceRole are guaranteed to be set.
 */
export const workspaceProcedure = protectedProcedure.use(async (opts) => {
  const { ctx } = opts;

  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Workspace ID required. Set active workspace in frontend.",
    });
  }

  // Verify user has access to workspace
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, ctx.workspaceId),
      eq(workspaceMembers.userId, ctx.userId)
    ),
  });

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied to workspace",
    });
  }

  logger.debug(
    { userId: ctx.userId, workspaceId: ctx.workspaceId, role: membership.role },
    "Workspace procedure - membership validated"
  );

  return opts.next({
    ctx: {
      ...ctx,
      workspaceId: ctx.workspaceId, // Ensure it's a string (not null)
      workspaceRole: membership.role, // Add role to context for convenience
    },
  });
});

/**
 * Pod-admin procedure (auth + pod admin role required)
 *
 * Restricts access to users who are an admin or owner of the pod-admin
 * workspace (the system workspace with settings.systemSlug = 'pod-admin').
 * Used for sensitive system operations: raw DB access, tool execution, event injection.
 */
export const podAdminProcedure = protectedProcedure.use(async (opts) => {
  const { ctx } = opts;

  // Find the pod-admin workspace
  const podAdminWorkspace = await db.query.workspaces.findFirst({
    where: drizzleSql`${workspaces.settings}->>'systemSlug' = 'pod-admin'`,
    columns: { id: true },
  });

  if (!podAdminWorkspace) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Pod administration workspace not found",
    });
  }

  // Verify user is an admin or owner of that workspace
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
      eq(workspaceMembers.userId, ctx.userId),
      inArray(workspaceMembers.role, ["admin", "owner"])
    ),
  });

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Pod admin access required",
    });
  }

  return opts.next({ ctx });
});

export const router = t.router as typeof t.router;
export const middleware = t.middleware as typeof t.middleware;
