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
  readBrokerTrustDiagnostics,
} from "@synap/api";
import { config, createLogger } from "@synap-core/core";

const logger = createLogger({ module: "connectors-router" });

/**
 * The audience a CP token must carry: PUBLIC_URL without trailing slashes —
 * the same spelling as `podAudience` in the source-config and federation
 * doors, so every CP→pod door accepts the same `aud`.
 */
function podAudience(): string | null {
  const value = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  return value || null;
}

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
// GET /broker-diagnostics — CP reads WHY this pod's broker is (un)usable
// ---------------------------------------------------------------------------

/** Same bound as the source-config door: a short-lived assertion, never a standing credential. */
const MAX_DIAGNOSTICS_ASSERTION_LIFETIME_SECONDS = 300;

const BrokerDiagnosticsClaimsSchema = z
  .object({
    type: z.literal("pod_trust_diagnostics"),
    iss: z.string().min(1),
    /** The CP subject a relay delivery for this pod would carry. */
    sub: z.string().min(1),
    // jsonwebtoken checks `exp` only when present, so both are required here.
    iat: z.number(),
    exp: z.number(),
  })
  .refine(
    (c) => c.exp - c.iat <= MAX_DIAGNOSTICS_ASSERTION_LIFETIME_SECONDS,
    "assertion lifetime too long"
  );

connectorsRouter.get("/broker-diagnostics", async (c) => {
  const token = c.req
    .header("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!token) return c.json({ error: "Missing Bearer token" }, 401);

  const podPublicUrl = podAudience();
  if (!podPublicUrl) {
    return c.json({ error: "PUBLIC_URL not configured; request refused" }, 500);
  }

  // An unapproved or unknown CP issuer is refused here, so a 401 from this door
  // is itself the signal that the pod does not trust the CP.
  const payload = await verifyCpJwtWithTrust<Record<string, unknown>>(token, {
    pinnedIssuer: config.server.controlPlaneUrl,
    audience: podPublicUrl,
  });
  const claims = BrokerDiagnosticsClaimsSchema.safeParse(payload);
  if (!payload || !claims.success) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  try {
    return c.json(
      await readBrokerTrustDiagnostics({
        issuerUrl: claims.data.iss,
        issuerSubject: claims.data.sub,
      }),
      200
    );
  } catch (err) {
    logger.error({ err }, "broker-diagnostics: read failed");
    return c.json({ error: "Broker diagnostics could not be read" }, 503);
  }
});

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

  const podPublicUrl = podAudience();
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
