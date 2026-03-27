/**
 * Credential Auto-Repair
 *
 * When the pod gets a 401 from the Intelligence Service, this module
 * automatically attempts to refresh credentials via the Control Plane.
 *
 * Flow:
 * 1. Pod detects 401 from IS (credential_error)
 * 2. Pod asks CP: POST /intelligence/provision/{podId} (re-provision)
 * 3. CP generates fresh key on IS, relays it to pod
 * 4. Pod stores new key, marks service as "active"
 * 5. Next request succeeds without user intervention
 *
 * Safeguards:
 * - Debounced: only one repair attempt per 60 seconds
 * - Non-blocking: runs in background, doesn't delay the current request
 * - Logged: all attempts and outcomes are logged for debugging
 */

import { db, eq } from "@synap/database";
import { intelligenceServices } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "credential-auto-repair" });

// Debounce: only attempt repair once per 60 seconds
let lastAttemptAt = 0;
const DEBOUNCE_MS = 60_000;
let repairInProgress = false;

/**
 * Attempt to auto-repair IS credentials by requesting re-provisioning from CP.
 * Call this when the pod gets a 401 from IS. Non-blocking — runs in background.
 */
export function triggerCredentialRepair(): void {
  const now = Date.now();
  if (repairInProgress || now - lastAttemptAt < DEBOUNCE_MS) {
    return;
  }
  lastAttemptAt = now;
  repairInProgress = true;

  // Fire and forget — don't block the caller
  doRepair()
    .catch((err) =>
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Credential auto-repair failed"
      )
    )
    .finally(() => {
      repairInProgress = false;
    });
}

async function doRepair(): Promise<void> {
  logger.info(
    "Starting credential auto-repair — requesting fresh IS key from CP"
  );

  // Read CP URL and podId from workspace settings
  const ws = await db.query.workspaces.findFirst({
    columns: { settings: true },
  });
  const settings = ws?.settings as Record<string, unknown> | null;
  const cp = settings?.controlPlane as
    | { url?: string; podId?: string }
    | undefined;

  if (!cp?.url || !cp?.podId) {
    logger.warn(
      "Cannot auto-repair: no Control Plane connection (url or podId missing)"
    );
    return;
  }

  // Build a lightweight auth token using the pod's internal key.
  // CP's /intelligence/provision endpoint requires authentication.
  const internalKey = process.env.SYNAP_POD_INTERNAL_KEY;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (internalKey) {
    headers["X-Internal-Key"] = internalKey;
  }

  // Ask CP to re-provision — this triggers IS key regeneration + relay
  const res = await fetch(`${cp.url}/intelligence/provision/${cp.podId}`, {
    method: "POST",
    headers,
    credentials: "include",
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    logger.warn(
      { status: res.status, error: body?.error },
      "CP re-provision request failed — credentials not refreshed"
    );
    return;
  }

  const data = (await res.json()) as {
    provisionToken?: string;
    serviceApiKey?: string;
  };

  // If CP returned a provision token, relay it to ourselves (the pod)
  // This triggers the /api/provision/connect → register-intelligence flow
  if (data.provisionToken) {
    try {
      const connectRes = await fetch(
        `http://localhost:${process.env.PORT || 4000}/api/provision/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: data.provisionToken }),
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (connectRes.ok) {
        logger.info(
          "Credential auto-repair succeeded — provision token applied"
        );
        // Mark any credential_error services as active — the register handler
        // may have already done this, but we ensure it here as well.
        await markCredentialErrorServicesActive();
        return;
      }
    } catch (relayErr) {
      logger.warn(
        {
          err: relayErr instanceof Error ? relayErr.message : String(relayErr),
        },
        "Failed to relay provision token to self"
      );
    }
  }

  logger.info(
    "Credential auto-repair: CP responded but no provision token — CP may need to relay separately"
  );
}

/** Mark all credential_error services as active (not just synap-hub). */
async function markCredentialErrorServicesActive(): Promise<void> {
  try {
    await db
      .update(intelligenceServices)
      .set({ status: "active" })
      .where(eq(intelligenceServices.status, "credential_error"));
  } catch {
    // Non-critical — the register-intelligence handler likely already updated this
  }
}
