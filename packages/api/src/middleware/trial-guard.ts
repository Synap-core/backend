/**
 * Trial Guard Middleware
 *
 * tRPC middleware that blocks write operations when a workspace's trial
 * has expired. Only activates on shared pods (SHARED_POD_MODE=true).
 *
 * Reads `workspace.settings.controlPlane.trialEnd` — if the date is in
 * the past, throws FORBIDDEN with message "TRIAL_EXPIRED".
 *
 * Usage:
 *   Apply to mutation procedures that should be gated by trial status.
 *
 *   export const trialProtectedProcedure = workspaceProcedure.use(trialGuardMiddleware);
 */

import { TRPCError } from "@trpc/server";
import { config, createLogger } from "@synap-core/core";
import { middleware } from "../trpc.js";
import { db, eq } from "@synap/database";
import { workspaces } from "@synap/database/schema";

const logger = createLogger({ module: "trial-guard" });

export const trialGuardMiddleware = middleware(async (opts) => {
  const { ctx, next } = opts;

  // Only enforce on shared pods
  if (!config.server.sharedPodMode) {
    return next({ ctx });
  }

  const workspaceId = (ctx as { workspaceId?: string }).workspaceId;
  if (!workspaceId) {
    // No workspace in context — let other middleware handle this
    return next({ ctx });
  }

  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });

    const settings = (ws?.settings as Record<string, unknown>) ?? {};
    const cp = settings.controlPlane as { trialEnd?: string } | undefined;
    const trialEnd = cp?.trialEnd;

    if (trialEnd && new Date(trialEnd) < new Date()) {
      const userId = (ctx as { userId?: string }).userId;
      logger.warn(
        { userId, workspaceId, trialEnd },
        "Trial expired — blocking mutation"
      );
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "TRIAL_EXPIRED",
      });
    }
  } catch (err) {
    // Re-throw TRPCErrors (including our own TRIAL_EXPIRED)
    if (err instanceof TRPCError) throw err;

    // Non-fatal DB errors — don't block the user on trial-check failures
    logger.warn({ err, workspaceId }, "Trial guard DB read failed — allowing");
  }

  return next({ ctx });
});
