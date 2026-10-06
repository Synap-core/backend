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
import { db, eq, and } from "@synap/database";
import { workspaceMembers, workspaces } from "@synap/database/schema";
import { listMemberWorkspaces } from "./utils/workspace-membership.js";
import { isPodAdmin } from "./utils/workspace-role.js";
import "@synap/database"; // Fix TS2742: inferred type portability
import {
  isSynapLikeError,
  isDbDomainError,
  mapDbErrorToTRPC,
  mapSetupRequiredToTRPC,
  statusCodeToTRPCCode,
} from "./utils/error-mappers.js";
import { isSetupRequiredLike } from "./services/proposals/setup-required-error.js";
import { auditLogMiddleware } from "./middleware/audit-log.js";
import { readOnlyGuardMiddleware } from "./middleware/read-only-guard.js";
import { guestContainmentMiddleware } from "./access/guest-containment.js";

const logger = createLogger({ module: "trpc" });

/**
 * Base error-catching middleware.
 *
 * Applied to every procedure (public, protected, workspace-scoped).
 * Converts domain-layer and service-layer exceptions into properly
 * typed TRPCErrors so the errorFormatter and clients always see
 * consistent error codes.
 *
 * ⚠️ tRPC 11 delivers a downstream throw as a RESOLVED `{ ok: false, error }`
 * result, not a rejection: `callRecursive` (`@trpc/server` dist) wraps EVERY
 * middleware/resolver call in its own try/catch and returns the converted
 * error, so `await next()` never rejects on a resolver error. The conversion
 * therefore inspects the RESULT first; the `catch` below is kept only as a
 * safety net for a future tRPC that rejects (and for a middleware that throws
 * synchronously before building a result).
 *
 * Conversion order:
 *   1. Setup-required   → map failureClass → tRPC code, keep payload as `cause`
 *   2. TRPCError        → pass through unchanged
 *   3. SynapError-like  → map statusCode → tRPC code
 *   4. DB domain errors → map to NOT_FOUND / BAD_REQUEST / CONFLICT
 *   5. Unknown          → INTERNAL_SERVER_ERROR
 *
 * Exported so the error-shape seam can be exercised end-to-end without a db or
 * a full server (see `__tests__/setup-required-trpc.test.ts`).
 */
export const errorCatchingMiddleware = t.middleware(async ({ next }) => {
  try {
    const result = await next();

    // THE LIVE PATH. A capability install that needs a HUMAN before it can
    // apply — a required param missing, or an account not connected — throws a
    // `SetupRequiredError` carrying NO `.code`. tRPC has already converted it
    // to an opaque `INTERNAL_SERVER_ERROR` with the original as `cause`, so
    // inspect `result.error.cause` and rebuild it through the shared
    // `failure-classification` mapping (the SAME 400/412 the Hub REST
    // `POST /capabilities/apply` door returns). The rebuilt error keeps the
    // `SetupRequiredError` as `cause`, which `init-trpc.ts` forwards as
    // `failureClass` / `missingFields` / `connection`.
    if (!result.ok && isSetupRequiredLike(result.error.cause)) {
      throw mapSetupRequiredToTRPC(result.error.cause);
    }

    // Same live path for a typed domain error (steps 3–4 of the order above):
    // tRPC has already wrapped it as `INTERNAL_SERVER_ERROR` with the original
    // as `cause`, so the `catch` below never sees it. Without this, every
    // ConflictError / NotFoundError thrown by a resolver reached the client as
    // an opaque 500 (probed 2026-10-06 through the fetch adapter).
    if (!result.ok && result.error.code === "INTERNAL_SERVER_ERROR") {
      const cause = result.error.cause;
      if (isSynapLikeError(cause)) {
        throw new TRPCError({
          code: statusCodeToTRPCCode(cause.statusCode),
          message: cause.message,
          cause,
        });
      }
      if (isDbDomainError(cause)) throw mapDbErrorToTRPC(cause);
    }

    return result;
  } catch (error) {
    // Already a tRPC error — pass through. (Catches the rethrow above too.)
    if (error instanceof TRPCError) throw error;

    // SynapError from @synap-core/core OR @synap-core/types (duck-typed)
    if (isSynapLikeError(error)) {
      throw new TRPCError({
        code: statusCodeToTRPCCode(error.statusCode),
        message: error.message,
        cause: error,
      });
    }

    // Defensive: a setup-required error reaching us by a routing path that
    // bypassed the result inspection above still converts identically.
    if (isSetupRequiredLike(error)) {
      throw mapSetupRequiredToTRPC(error);
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
 * Base error-catching middleware applied to all procedures, then guest
 * containment: every procedure is built from this one, so a signed-in guest's
 * mutation is refused here whichever router it lives in (see
 * `access/guest-containment.ts`).
 */
export const publicProcedure = t.procedure
  .use(errorCatchingMiddleware)
  .use(guestContainmentMiddleware);

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
 * The workspace gate, extracted from `workspaceProcedure` so a procedure that
 * must resolve its workspace FROM ITS INPUT (rather than from the ambient
 * `X-Workspace-Id` header) can apply the identical checks afterwards instead of
 * forking them. `playbooks.run` is the first such caller: it derives the run's
 * write workspace from the playbook via `resolvePlaybookRunWriteWorkspace` and
 * then gates on THAT workspace.
 *
 * Checks, in order: membership (with the candidate-listing denial message) and
 * the archived-workspace refusal. Returns the member's role.
 */
export async function assertWorkspaceUsable(
  userId: string,
  workspaceId: string
): Promise<{ role: string }> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
  });

  if (!membership) {
    throw await workspaceMembershipDenied(userId, workspaceId);
  }

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, workspaceId),
    columns: { archivedAt: true },
  });

  if (workspace?.archivedAt != null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This workspace has been archived.",
    });
  }

  return { role: membership.role };
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

  // Verify user has access to workspace (membership + not archived) — the ONE
  // derivation, shared with input-resolved-workspace callers.
  const membership = await assertWorkspaceUsable(ctx.userId, ctx.workspaceId);

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
 * the membership query. The predicate itself is `isPodAdmin`
 * (`utils/workspace-role.ts`): a FAILED membership read throws through it and
 * never reads as "not an admin".
 */
export async function assertPodAdmin(userId: string): Promise<void> {
  if (!(await isPodAdmin(userId))) {
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
