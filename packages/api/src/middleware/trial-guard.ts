/**
 * Trial Guard Middleware
 *
 * tRPC middleware that refuses write operations once the pod's trial has
 * ended. Pod-level: it reads the pod's PLAN (`readControlPlaneEntitlement`,
 * `@synap/database` utils/control-plane-link.ts — pulled from the Control
 * Plane by `@synap/jobs` `cp-entitlement-sync`), on every CP-linked pod.
 *
 * The mildest block (lane cp-link D1, NEEDS-FOUNDER-CONFIRM): only mutations
 * behind this middleware are refused, with `reasonCode: "TRIAL_EXPIRED"` and a
 * sentence that names the fix; reads and exports stay open. It blocks ONLY on a
 * plan the CP stated as `trialing` whose `trialEnd` has passed. No plan record,
 * a failed pull or a failed read is unknown, never expired: it never blocks.
 *
 * Usage:
 *   export const trialProtectedProcedure = workspaceProcedure.use(trialGuardMiddleware);
 */

import { TRPCError } from "@trpc/server";
import { config, createLogger } from "@synap-core/core";
import { t } from "../init-trpc.js";
import { readControlPlaneEntitlement } from "@synap/database";

const logger = createLogger({ module: "trial-guard" });

export const TRIAL_EXPIRED_REASON = "TRIAL_EXPIRED";
export const TRIAL_EXPIRED_MESSAGE =
  "Your trial ended. Choose a plan to keep editing.";

export const trialGuardMiddleware = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  // Only a pod linked to a Control Plane has a plan to enforce.
  if (!config.server.controlPlaneUrl) {
    return next({ ctx });
  }

  let plan: Awaited<ReturnType<typeof readControlPlaneEntitlement>>;
  try {
    plan = await readControlPlaneEntitlement();
  } catch (err) {
    // Unknown is not expired — never block on a read we could not make.
    logger.warn(
      { err },
      "Trial guard could not read the pod's plan — allowing"
    );
    return next({ ctx });
  }

  if (
    plan?.status === "trialing" &&
    plan.trialEnd &&
    new Date(plan.trialEnd).getTime() < Date.now()
  ) {
    const userId = (ctx as { userId?: string }).userId;
    logger.warn(
      { userId, trialEnd: plan.trialEnd },
      "Trial ended — refusing mutation"
    );
    throw new TRPCError({
      code: "FORBIDDEN",
      message: TRIAL_EXPIRED_MESSAGE,
      cause: { reasonCode: TRIAL_EXPIRED_REASON },
    });
  }

  return next({ ctx });
});
