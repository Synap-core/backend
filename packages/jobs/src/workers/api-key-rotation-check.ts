/**
 * API Key Rotation Check Worker
 *
 * Cron job that flags agent hub keys whose `rotation_scheduled_at` has passed
 * (mirrors ApiKeyService.getKeysScheduledForRotation).
 *
 * FLAG-ONLY — this worker does NOT rotate keys. Rotating a live `hub_inbound`
 * key mints a NEW plaintext that is one-shot returned by POST /setup/agent and
 * is NEVER pushed to wherever the IS / agent stores its credential. There is no
 * backend→IS propagation path (ApiKeyService.rotateApiKey has no production
 * caller by design), so auto-rotating a live key would 401 the agent. Until a
 * verified rotation+propagation path exists, we only LOG the due keys so an
 * operator can re-provision manually (re-run POST /api/hub/setup/agent, which
 * revokes-then-mints and returns a fresh plaintext the agent can store).
 */

import { db, apiKeys, and, eq } from "@synap/database";
import { sql } from "drizzle-orm";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "api-key-rotation-check" });

export const API_KEY_ROTATION_CHECK_QUEUE = "api-key-rotation-check";

/**
 * Called by the cron scheduler (daily). Logs active keys whose scheduled
 * rotation time has passed. No mutation — see file header for why rotation is
 * not automated.
 */
export async function handleApiKeyRotationCheck(): Promise<void> {
  const due = await db
    .select({
      id: apiKeys.id,
      keyName: apiKeys.keyName,
      userId: apiKeys.userId,
      keyType: apiKeys.keyType,
      expiresAt: apiKeys.expiresAt,
      rotationScheduledAt: apiKeys.rotationScheduledAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.isActive, true),
        sql`${apiKeys.rotationScheduledAt} < NOW()`
      )
    );

  if (due.length === 0) {
    logger.debug("No API keys due for rotation");
    return;
  }

  logger.warn(
    {
      count: due.length,
      keys: due.map((k) => ({
        id: k.id.slice(0, 8),
        keyName: k.keyName,
        keyType: k.keyType,
        expiresAt: k.expiresAt,
        rotationScheduledAt: k.rotationScheduledAt,
      })),
    },
    "API keys due for rotation — re-provision manually via POST /api/hub/setup/agent. " +
      "Auto-rotation is disabled: a rotated key's new secret is not propagated to the IS/agent."
  );
}
