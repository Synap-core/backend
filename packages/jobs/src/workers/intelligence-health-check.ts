/**
 * Intelligence Health Check Worker
 *
 * Cron job that runs every 2 minutes.
 * Pings the /health endpoint of all active intelligence services and updates
 * `lastHealthCheck` + `lastHealthStatus` in the DB.
 *
 * Service status values: "healthy" | "degraded" | "unhealthy"
 * - healthy:  /health returned 2xx with status "ok"
 * - degraded: /health returned 2xx but status was not "ok" (e.g. "degraded")
 * - unhealthy: /health timed out or returned non-2xx
 */

import { db, intelligenceServices, eq, and } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "intelligence-health-check" });

const HEALTH_TIMEOUT_MS = 5_000;

type ServiceHealthStatus = "healthy" | "degraded" | "unhealthy";

async function pingService(webhookUrl: string): Promise<{
  status: ServiceHealthStatus;
  latencyMs: number;
  keyExpiresSoon: boolean;
  keyExpiresAt: string | null;
}> {
  const start = Date.now();
  try {
    const res = await fetch(`${webhookUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const latencyMs = Date.now() - start;

    // Check for key expiry warning headers from IS auth middleware
    const keyExpiresSoon = res.headers.get("X-Key-Expires-Soon") === "true";
    const keyExpiresAt = res.headers.get("X-Key-Expires-At");

    if (!res.ok)
      return { status: "unhealthy", latencyMs, keyExpiresSoon, keyExpiresAt };
    // Check for degraded status in JSON body (optional)
    try {
      const body = (await res.json()) as { status?: string };
      if (body?.status && body.status !== "ok" && body.status !== "healthy") {
        return { status: "degraded", latencyMs, keyExpiresSoon, keyExpiresAt };
      }
    } catch {
      // Non-JSON body — still OK if HTTP 2xx
    }
    return { status: "healthy", latencyMs, keyExpiresSoon, keyExpiresAt };
  } catch {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - start,
      keyExpiresSoon: false,
      keyExpiresAt: null,
    };
  }
}

/**
 * Called by the cron scheduler every 2 minutes.
 * Fetches all active, non-default services and pings them.
 */
export async function handleIntelligenceHealthCheck(): Promise<void> {
  const services = await db.query.intelligenceServices.findMany({
    where: and(
      eq(intelligenceServices.status, "active"),
      eq(intelligenceServices.enabled, true)
    ),
    columns: {
      id: true,
      serviceId: true,
      webhookUrl: true,
    },
  });

  // Filter out the synthetic default service (no real URL to ping)
  const external = services.filter(
    (s) => s.serviceId !== "default" && s.webhookUrl
  );

  if (external.length === 0) {
    logger.debug("No external intelligence services to health-check");
    return;
  }

  logger.debug(
    { count: external.length },
    "Running intelligence service health checks"
  );

  const results = await Promise.allSettled(
    external.map(async (svc) => {
      const { status, latencyMs, keyExpiresSoon, keyExpiresAt } =
        await pingService(svc.webhookUrl);

      // If key is expiring soon, set status to "expiring" so the frontend can warn
      const effectiveStatus: ServiceHealthStatus | "expiring" =
        keyExpiresSoon && status === "healthy" ? "expiring" : status;

      if (keyExpiresSoon) {
        logger.warn(
          { serviceId: svc.serviceId, keyExpiresAt },
          "Intelligence service API key expires soon — re-provision to refresh"
        );
      }

      const checkedAt = new Date();
      await db
        .update(intelligenceServices)
        .set({
          lastHealthCheck: checkedAt,
          lastHealthStatus: effectiveStatus,
          updatedAt: checkedAt,
          // Update main status to "expiring" if key is nearing expiry
          ...(effectiveStatus === "expiring" ? { status: "expiring" } : {}),
        })
        .where(eq(intelligenceServices.id, svc.id));
      return { serviceId: svc.serviceId, status: effectiveStatus, latencyMs };
    })
  );

  // Log summary
  const summary = results
    .filter((r) => r.status === "fulfilled")
    .map(
      (r) =>
        (
          r as PromiseFulfilledResult<{
            serviceId: string;
            status: string;
            latencyMs: number;
          }>
        ).value
    );

  const healthy = summary.filter((s) => s.status === "healthy").length;
  const unhealthy = summary.filter((s) => s.status === "unhealthy").length;
  const degraded = summary.filter((s) => s.status === "degraded").length;

  if (unhealthy > 0 || degraded > 0) {
    logger.warn(
      { healthy, degraded, unhealthy, total: external.length },
      "Intelligence service health check: some services are unhealthy"
    );
  } else {
    logger.debug(
      { healthy, total: external.length },
      "Intelligence service health check: all healthy"
    );
  }
}
