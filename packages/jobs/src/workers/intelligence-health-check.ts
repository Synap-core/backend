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

/**
 * IoC slot for the operator nudge (in-app notification + Discord notice),
 * which lives in @synap/api because it needs NotificationService.
 *
 * This worker computed "degraded"/"unhealthy" correctly for a long time and
 * then only logged it — which is how an 8-day agent outage stayed invisible.
 * The alert itself is NOT reimplemented here: apps/api fills this slot at boot
 * with `notifyIntelligenceServiceUnhealthy`, which routes into the same
 * `notifyConnectorUnhealthy` door (same 6h dedup, same channels) the connector
 * crons use. @synap/jobs cannot statically import @synap/api (circular dep),
 * hence the slot — the pattern already used by `registerSignalRouter`.
 */
type ServiceHealthNotifier = (input: {
  serviceRowId: string;
  serviceId: string;
  serviceName: string;
  healthStatus: string;
  metadata: Record<string, unknown> | null | undefined;
  detail?: string;
}) => Promise<boolean>;

let serviceHealthNotifier: ServiceHealthNotifier | null = null;

export function registerServiceHealthNotifier(fn: ServiceHealthNotifier): void {
  serviceHealthNotifier = fn;
}

/**
 * Pull the failing detail out of a /health payload — `checks.<name>.detail`
 * for every check that is not ok. This is the evidence the operator needs
 * ("agentTurns: 402 Insufficient Balance"); when the payload carries none, the
 * caller says so rather than inventing one.
 */
function summarizeFailingChecks(body: unknown): string | undefined {
  const checks = (body as { checks?: Record<string, unknown> } | null)?.checks;
  if (!checks || typeof checks !== "object") return undefined;
  const failing: string[] = [];
  for (const [name, raw] of Object.entries(checks)) {
    const check = raw as { status?: unknown; detail?: unknown } | null;
    const status = typeof check?.status === "string" ? check.status : undefined;
    if (!status || status === "ok" || status === "healthy") continue;
    const detail = typeof check?.detail === "string" ? check.detail : status;
    failing.push(`${name}: ${detail}`);
  }
  return failing.length > 0 ? failing.join("; ") : undefined;
}

async function pingService(webhookUrl: string): Promise<{
  status: ServiceHealthStatus;
  latencyMs: number;
  keyExpiresSoon: boolean;
  keyExpiresAt: string | null;
  /** Evidence for the alert — absent when /health gave none. */
  detail?: string;
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
      return {
        status: "unhealthy",
        latencyMs,
        keyExpiresSoon,
        keyExpiresAt,
        detail: `/health returned HTTP ${res.status} ${res.statusText}`.trim(),
      };
    // Check for degraded status in JSON body (optional)
    try {
      const body = (await res.json()) as { status?: string };
      if (body?.status && body.status !== "ok" && body.status !== "healthy") {
        return {
          status: "degraded",
          latencyMs,
          keyExpiresSoon,
          keyExpiresAt,
          detail:
            summarizeFailingChecks(body) ??
            `/health reported status "${body.status}"`,
        };
      }
    } catch {
      // Non-JSON body — still OK if HTTP 2xx
    }
    return { status: "healthy", latencyMs, keyExpiresSoon, keyExpiresAt };
  } catch (err) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - start,
      keyExpiresSoon: false,
      keyExpiresAt: null,
      detail: `/health could not be reached: ${
        err instanceof Error ? err.message : String(err)
      }`,
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
      name: true,
      webhookUrl: true,
      // Carries the alert's 6h dedup watermark (connectionHealth.<key>).
      metadata: true,
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
      const { status, latencyMs, keyExpiresSoon, keyExpiresAt, detail } =
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

      // The verdict now LEAVES this worker. Deduped 6h-per-service inside the
      // shared door, so a service that stays down does not alert every tick.
      if (status === "degraded" || status === "unhealthy") {
        if (serviceHealthNotifier) {
          await serviceHealthNotifier({
            serviceRowId: svc.id,
            serviceId: svc.serviceId,
            serviceName: svc.name,
            healthStatus: status,
            metadata: svc.metadata,
            detail,
          }).catch((err) =>
            logger.warn(
              { err, serviceId: svc.serviceId },
              "Intelligence health nudge failed"
            )
          );
        } else {
          logger.warn(
            { serviceId: svc.serviceId },
            "Intelligence health notifier not registered — outage will not be surfaced"
          );
        }
      }
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
