/**
 * Read-Only Guard Middleware
 *
 * Blocks write mutations when the pod is in read-only mode after a split-brain
 * event. Applied as a tRPC middleware on mutation procedures.
 *
 * Read-only mode is set when:
 * - Split-brain detected AND this pod had fewer writes during the partition
 * - sync_generation.role = 'readonly'
 *
 * Cleared by:
 * - POST /api/sync/promote (CP-JWT-gated admin action)
 */

import { TRPCError } from "@trpc/server";
import { t } from "../init-trpc.js";
import { isPodReadOnly } from "../utils/split-brain-service.js";

/**
 * tRPC middleware that rejects mutations when the pod is read-only.
 * Attach to mutation procedures that should be blocked during split-brain.
 *
 * Usage (in trpc.ts or per-router):
 *   .use(readOnlyGuardMiddleware)
 */
export const readOnlyGuardMiddleware = t.middleware(async ({ type, next }) => {
  // Only block mutations — queries and subscriptions are always allowed
  if (type === "mutation") {
    const readOnly = await isPodReadOnly();
    if (readOnly) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Pod is in read-only mode after split-brain recovery. " +
          "Promote to primary to resume writes. " +
          "POST /api/sync/promote with CP-signed JWT.",
      });
    }
  }

  return next();
});
