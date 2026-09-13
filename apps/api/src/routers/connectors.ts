/**
 * Connectors REST Router
 *
 * Handles CP → Pod communication for external connections.
 * All endpoints use CP JWT verification (same trust rail as the provision router).
 *
 * Routes:
 *   POST /sync-trigger — The CP saw provider activity for a connection (Nango
 *                         `sync` / `auth` webhook). Enqueue the ONE connection
 *                         sync door; the pod reads the provider itself through
 *                         its capability verbs.
 *
 * (POST /disconnect was removed 2026-09-13: the CP user-session connector routes
 * that signed its `connector_disconnect` token were retired, leaving no sender.)
 */

import { Hono } from "hono";
import { z } from "zod";
import { getDb, eq, and, isNull, isNotNull } from "@synap/database";
import { secrets } from "@synap/database/schema";
import {
  verifyCpJwtWithTrust,
  enqueueConnectionSync,
  reconcileLiveConnections,
} from "@synap/api";
import { config, createLogger } from "@synap-core/core";

const logger = createLogger({ module: "connectors-router" });

export const connectorsRouter = new Hono();

/**
 * The pod's connection registry row for a broker connection id — owned by THIS
 * user, a capability connection, not deleted.
 */
async function findConnectionRow(
  brokerConnectionId: string,
  podUserId: string
): Promise<{ id: string } | null> {
  const database = await getDb();
  const [conn] = await database
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.accountHint, brokerConnectionId),
        eq(secrets.userId, podUserId),
        isNotNull(secrets.capabilityId),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1);
  return conn ?? null;
}

// ---------------------------------------------------------------------------
// POST /sync-trigger — CP webhook poke → enqueue the connection sync
// ---------------------------------------------------------------------------

const SyncTriggerClaimsSchema = z.object({
  type: z.literal("connector_sync_trigger"),
  providerConfigKey: z.string().min(1),
  /** The broker's (Nango's) connection id — `secrets.accountHint` on the pod. */
  connectionId: z.string().min(1),
  podUserId: z.string().min(1),
});

connectorsRouter.post("/sync-trigger", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ token: z.string().min(1) }).safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const podPublicUrl = process.env.PUBLIC_URL;
  if (!podPublicUrl) {
    logger.error(
      "sync-trigger refused: PUBLIC_URL not configured — audience check is mandatory"
    );
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  const payload = await verifyCpJwtWithTrust<Record<string, unknown>>(
    parsed.data.token,
    { pinnedIssuer: config.server.controlPlaneUrl, audience: podPublicUrl }
  );
  const claims = SyncTriggerClaimsSchema.safeParse(payload);
  if (!payload || !claims.success) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  const { providerConfigKey, connectionId, podUserId } = claims.data;

  // The broker id names the account; the pod's connection registry row is the
  // sync identity.
  let conn = await findConnectionRow(connectionId, podUserId);
  if (!conn) {
    // The webhook can arrive before anything mirrored a fresh connection into
    // the registry (OAuth finished with no client refetch). Mirror it now —
    // inserting the row enqueues its first sync — and look again.
    let mirrored: Awaited<ReturnType<typeof reconcileLiveConnections>>;
    try {
      // Reads the user's complete live list from the broker itself.
      mirrored = await reconcileLiveConnections(podUserId);
    } catch (err) {
      mirrored = {
        ok: false,
        reason: "threw",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!mirrored.ok) {
      // Could not read the live list: retryable, and not the same fact as
      // "this connection does not exist".
      logger.warn(
        { provider: providerConfigKey, podUserId, error: mirrored.error },
        "sync-trigger: connection not mirrored and the live list is unreadable"
      );
      return c.json({ error: "Connection broker unavailable" }, 503);
    }
    conn = await findConnectionRow(connectionId, podUserId);
  }
  if (!conn) {
    // The CP retries a 404 a bounded number of times, so a miss while a
    // connection is still settling is expected, not a failure.
    logger.warn(
      { provider: providerConfigKey, podUserId },
      "sync-trigger: no matching connection on this pod"
    );
    return c.json({ error: "No matching connection on this pod" }, 404);
  }

  try {
    await enqueueConnectionSync({
      provider: providerConfigKey,
      connectionId: conn.id,
      reason: "webhook",
    });
  } catch (err) {
    // Queue down → 503 so the CP job retries; acking would drop the poke.
    logger.error(
      { err, provider: providerConfigKey },
      "sync-trigger: enqueue failed"
    );
    return c.json({ error: "Sync queue unavailable" }, 503);
  }

  return c.json({ accepted: true, connectionId: conn.id }, 202);
});
