/**
 * Credential Status Management
 *
 * When the pod gets a 401 from the Intelligence Service, it marks the
 * service as 'credential_error' in the local DB. The pod does NOT call
 * the Control Plane — provisioning/re-provisioning is the frontend's
 * responsibility.
 *
 * Flow:
 * 1. Pod detects 401 from IS → markServiceCredentialError()
 * 2. GET /api/provision/status reports credentialsValid: false
 * 3. Frontend detects via useIntelligenceStatus → 'out_of_sync'
 * 4. Frontend calls CP: POST /intelligence/provision/{podId}
 * 5. CP pushes fresh credentials to pod
 * 6. Pod marks service as 'active' (via /api/provision/register-intelligence)
 */

import { db, eq } from "@synap/database";
import { intelligenceServices } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "credential-status" });

// Debounce: only update status once per 60 seconds
let lastMarkAt = 0;
const DEBOUNCE_MS = 60_000;

/**
 * Mark the Intelligence Service as having invalid credentials.
 * Called when the pod gets a 401 from IS. Non-blocking.
 *
 * The frontend will detect this via /api/provision/status and
 * trigger re-provisioning through the Control Plane.
 */
export function markServiceCredentialError(): void {
  const now = Date.now();
  if (now - lastMarkAt < DEBOUNCE_MS) return;
  lastMarkAt = now;

  doMark().catch((err) =>
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to mark service as credential_error"
    )
  );
}

async function doMark(): Promise<void> {
  // Find the active synap-hub service and mark it
  const service = await db.query.intelligenceServices.findFirst({
    where: eq(intelligenceServices.serviceId, "synap-hub"),
  });

  if (!service) {
    logger.warn("No synap-hub service found to mark as credential_error");
    return;
  }

  if (service.status === "credential_error") {
    // Already marked — don't spam the log
    return;
  }

  await db
    .update(intelligenceServices)
    .set({ status: "credential_error" })
    .where(eq(intelligenceServices.id, service.id));

  logger.warn(
    "Intelligence Service marked as credential_error — frontend should trigger re-provisioning via CP"
  );
}

/**
 * @deprecated Use markServiceCredentialError instead.
 * Kept for backward compat — callers that still reference triggerCredentialRepair
 * will now just mark the status without calling CP.
 */
export function triggerCredentialRepair(): void {
  markServiceCredentialError();
}
