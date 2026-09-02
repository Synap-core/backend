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

import { TRPCError } from "@trpc/server";
import { t } from "./init-trpc.js";
import { requireUserId } from "./utils/user-scoped.js";
import { createLogger } from "@synap-core/core";
import { db, eq, and, inArray } from "@synap/database";
import { workspaceMembers, workspaces } from "@synap/database/schema";
import { listMemberWorkspaces } from "./utils/workspace-membership.js";
import "@synap/database"; // Fix TS2742: inferred type portability
import {
  isSynapLikeError,
  isDbDomainError,
  mapDbErrorToTRPC,
  statusCodeToTRPCCode,
} from "./utils/error-mappers.js";
import { auditLogMiddleware } from "./middleware/audit-log.js";
import { readOnlyGuardMiddleware } from "./middleware/read-only-guard.js";

const logger = createLogger({ module: "trpc" });

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
      message:
        process.env.NODE_ENV !== "production"
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
export const protectedProcedure = publicProcedure
  .use(async (opts) => {
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
  })
  .use(readOnlyGuardMiddleware)
  .use(auditLogMiddleware);

/** How many candidate workspaces the denial message names before eliding. */
const DENIAL_CANDIDATE_LIMIT = 8;

/**
 * Build the actionable body of a "not a member of that workspace" denial.
 *
 * Why the candidates are safe to disclose: `available` comes from
 * {@link listMemberWorkspaces}, whose only predicate is
 * `workspaceMembers.userId = <caller>`. It can therefore only ever name
 * workspaces the caller is ALREADY a member of — it reveals nothing about a
 * team pod's other workspaces or other members. (This is also why the broader
 * `getUserWorkspaceIds()` is NOT used: it folds in pod_visible/pod_joinable
 * workspaces the caller is not a member of, which would fail this very check.)
 *
 * `rejected` is echoed back because it is the caller's own input, and because
 * the failure mode this exists for — passing a POD id where a WORKSPACE id
 * belongs; both are bare UUIDs — is invisible without seeing which id lost.
 * The pod-id case is only a HINT: a pod cannot know its own Control Plane pod
 * id, so this layer can never confirm it.
 *
 * Exported for tests; the two membership middlewares below are its only
 * production callers.
 */
export function buildWorkspaceDenialMessage(
  rejected: string,
  available: Array<{ id: string; name: string }>
): string {
  if (available.length === 0) {
    return (
      `Access denied to workspace ${rejected} — you are not a member of it, ` +
      `and you are not a member of any workspace yet. Create or join one first.`
    );
  }
  const shown = available.slice(0, DENIAL_CANDIDATE_LIMIT);
  const list = shown.map((w) => `${w.name} (${w.id})`).join("; ");
  const elided = available.length - shown.length;
  return (
    `Access denied to workspace ${rejected} — you are not a member of it. ` +
    `Pass one of your workspaces instead (X-Workspace-Id header, or workspaceId): ` +
    `${list}${elided > 0 ? `; +${elided} more` : ""}. ` +
    `If that id came from pod configuration it may be a POD id, not a workspace id — ` +
    `the two are both bare UUIDs.`
  );
}

/**
 * The one door for the membership denial thrown by `workspaceProcedure` and
 * `podProcedure`. Code stays FORBIDDEN — only the message becomes actionable.
 * The extra query runs ONLY on the already-failing path.
 */
async function workspaceMembershipDenied(
  userId: string,
  workspaceId: string
): Promise<TRPCError> {
  let available: Array<{ id: string; name: string }> = [];
  try {
    available = await listMemberWorkspaces(userId);
  } catch (error) {
    // A denial must stay a denial even if the candidate lookup fails.
    logger.warn(
      { err: error, userId },
      "Could not list member workspaces for denial message"
    );
  }
  return new TRPCError({
    code: "FORBIDDEN",
    message: buildWorkspaceDenialMessage(workspaceId, available),
  });
}

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
    throw await workspaceMembershipDenied(ctx.userId, ctx.workspaceId);
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, ctx.workspaceId),
    columns: { archivedAt: true },
  });

  if (workspace?.archivedAt != null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This workspace has been archived.",
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
 * Pod procedure (auth + optional workspace)
 *
 * Tolerates workspace-less callers (new users, hydration onboarding, pod-wide reads).
 * If X-Workspace-Id header is present, verifies membership and provides
 * ctx.workspaceRole. If absent, ctx.workspaceId stays null and ctx.workspaceRole
 * is undefined — the procedure body is responsible for deciding whether that's OK
 * (typically: pod-wide profiles (entityScope='pod') work; workspace-scoped don't).
 *
 * Use this for any endpoint that must function during onboarding before a workspace
 * exists, or that operates on pod-wide data (entities, channels, proposals) where
 * the workspace lens is optional.
 */
export const podProcedure = protectedProcedure.use(async (opts) => {
  const { ctx } = opts;

  if (!ctx.workspaceId) {
    return opts.next({
      ctx: {
        ...ctx,
        workspaceId: null as string | null,
        workspaceRole: undefined as string | undefined,
      },
    });
  }

  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, ctx.workspaceId),
      eq(workspaceMembers.userId, ctx.userId)
    ),
  });

  if (!membership) {
    throw await workspaceMembershipDenied(ctx.userId, ctx.workspaceId);
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, ctx.workspaceId),
    columns: { archivedAt: true },
  });

  if (workspace?.archivedAt != null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This workspace has been archived.",
    });
  }

  return opts.next({
    ctx: {
      ...ctx,
      workspaceId: ctx.workspaceId as string | null,
      workspaceRole: membership.role as string | undefined,
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
  await assertPodAdmin(opts.ctx.userId);
  return opts.next({ ctx: opts.ctx });
});

/**
 * THE pod-admin check: is `userId` an admin/owner of the pod-admin workspace?
 * Throws `FORBIDDEN` otherwise.
 *
 * Extracted from `podAdminProcedure` (its only body) so a procedure that is
 * NOT wholly pod-admin can still require pod-admin for a SUBSET of its input —
 * `profiles.update` gates its pod-wide fields on an unowned (system/shared)
 * profile this way. One mechanism, two entry points; never a second copy of
 * the membership query.
 */
export async function assertPodAdmin(userId: string): Promise<void> {
  // Find the pod-admin workspace
  const podAdminWorkspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.systemSlug, "pod-admin"),
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
      eq(workspaceMembers.userId, userId),
      inArray(workspaceMembers.role, ["admin", "owner"])
    ),
  });

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Pod admin access required",
    });
  }
}

export { t };
export const router = t.router as typeof t.router;
export const middleware = t.middleware as typeof t.middleware;
export const mergeRouters = t.mergeRouters as typeof t.mergeRouters;

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
