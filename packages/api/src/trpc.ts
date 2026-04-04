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
import {
  isSynapLikeError,
  isDbDomainError,
  mapDbErrorToTRPC,
  statusCodeToTRPCCode,
} from "./utils/error-mappers.js";

const logger = createLogger({ module: "trpc" });

const isDev = process.env.NODE_ENV !== "production";

const t = initTRPC.context<Context>().create({
  transformer: superjson,

  /**
   * Global error formatter — runs after every procedure error.
   * Responsible for:
   *   1. Logging all errors (once, in one place)
   *   2. Stripping internal error messages in production
   */
  errorFormatter({ shape, error, type, path }) {
    const isInternal = shape.data.code === "INTERNAL_SERVER_ERROR";

    // Log server errors with full context
    if (isInternal) {
      logger.error(
        { err: error.cause ?? error, type, path, code: shape.data.code },
        "Internal server error in tRPC procedure"
      );
    } else {
      logger.debug(
        { type, path, code: shape.data.code, message: shape.message },
        "tRPC procedure error"
      );
    }

    return {
      ...shape,
      message:
        isInternal && !isDev ? "An unexpected error occurred" : shape.message,
    };
  },
});

/**
 * Base error-catching middleware.
 *
 * Applied to every procedure (public, protected, workspace-scoped).
 * Converts domain-layer and service-layer exceptions into properly
 * typed TRPCErrors so the errorFormatter and clients always see
 * consistent error codes.
 *
 * Conversion order:
 *   1. TRPCError        → pass through unchanged
 *   2. SynapError-like  → map statusCode → tRPC code
 *   3. DB domain errors → map to NOT_FOUND / BAD_REQUEST / CONFLICT
 *   4. Unknown          → INTERNAL_SERVER_ERROR
 */
const errorCatchingMiddleware = t.middleware(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    // Already a tRPC error — pass through
    if (error instanceof TRPCError) throw error;

    // SynapError from @synap-core/core OR @synap-core/types (duck-typed)
    if (isSynapLikeError(error)) {
      throw new TRPCError({
        code: statusCodeToTRPCCode(error.statusCode),
        message: error.message,
        cause: error,
      });
    }

    // @synap/database domain exceptions (ProfileNotFoundError, etc.)
    if (isDbDomainError(error)) {
      throw mapDbErrorToTRPC(error);
    }

    // Truly unexpected — log will happen in errorFormatter
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: isDev
        ? error instanceof Error
          ? error.message
          : String(error)
        : "An unexpected error occurred",
      cause: error,
    });
  }
});

/**
 * Public procedure (no auth required)
 * Base error-catching middleware applied to all procedures.
 */
export const publicProcedure = t.procedure.use(errorCatchingMiddleware);

/**
 * Protected procedure (auth required)
 *
 * Validates Ory Kratos session. Authorization handled by permissionValidator worker.
 */
export const protectedProcedure = publicProcedure.use(async (opts) => {
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

/**
 * Workspace mutation procedure (workspace-scoped + trial guard)
 *
 * Same as workspaceProcedure but additionally checks whether the workspace
 * trial has expired (shared pod mode only). Use this for all write operations
 * that should be blocked after trial expiry.
 *
 * Usage:
 *   import { workspaceMutationProcedure } from "../trpc.js";
 *   myRouter = router({
 *     create: workspaceMutationProcedure.input(...).mutation(...)
 *   });
 */
import { trialGuardMiddleware } from "./middleware/trial-guard.js";
export { trialGuardMiddleware };

export const workspaceMutationProcedure =
  workspaceProcedure.use(trialGuardMiddleware);
