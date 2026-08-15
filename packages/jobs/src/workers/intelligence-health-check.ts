/**
 * Intelligence Health Check Worker
 *
 * Cron job that runs every 2 minutes.
 * Pings the /health endpoint of all active intelligence services and updates
 * `lastHealthCheck` + `lastHealthStatus` in the DB.
 *
 * Service status values: "healthy" | "degraded" | "unhealthy" | "unmonitored"
 * - healthy:  /health returned 2xx with status "ok"
 * - degraded: /health returned 2xx but status was not "ok" (e.g. "degraded")
 * - unhealthy: /health timed out or returned non-2xx
 * - unmonitored: this worker CANNOT ping it (no webhookUrl) — recorded
 *   explicitly so an unwatched service is VISIBLE rather than silently absent
 *   from a green list. See `classifyServicesForHealthCheck`.
 */

import { db, intelligenceServices, eq } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "intelligence-health-check" });

const HEALTH_TIMEOUT_MS = 5_000;

type ServiceHealthStatus = "healthy" | "degraded" | "unhealthy" | "unmonitored";

/**
 * Lifecycle states this worker still monitors.
 *
 * `expiring` is included DELIBERATELY: this worker itself writes
 * `status:'expiring'` when the IS reports a key nearing expiry, so a query that
 * only accepted `'active'` made the worker SILENCE ITSELF — the first expiry
 * warning was also the last health check that service ever got. Filtering in TS
 * (rather than widening the SQL predicate) keeps the whole monitored/unmonitored
 * decision readable in ONE place, which is the entire point of this file.
 */
const MONITORED_STATUSES = new Set(["active", "expiring"]);

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
    // "skip" = the IS declined to assert anything (e.g. no embedding call since
    // boot). Not-asserted is not failing — reporting it as evidence of an
    // outage would train the operator to ignore this alert.
    if (!status || status === "ok" || status === "healthy" || status === "skip")
      continue;
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

/** The shape this worker needs off an `intelligence_services` row. */
export interface HealthCheckCandidate {
  id: string;
  serviceId: string;
  name: string;
  webhookUrl: string | null;
  status: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Split enabled services into the ones this worker CAN ping and the ones it
 * cannot — the honesty seam.
 *
 * The old filter was `serviceId !== "default" && webhookUrl`, and BOTH halves
 * were wrong in the same way: a skipped pod simply vanished from the summary,
 * so "0 unhealthy" was reported over a fleet nobody was watching.
 *
 *  • `serviceId === "default"` was excluded as "synthetic, no real URL to ping".
 *    That is falsified by the row itself: a default-registration pod carries a
 *    perfectly pingable `webhookUrl` (it is the very endpoint
 *    `resolveDefaultIntelligenceEndpoint` hands every worker). The URL check
 *    below already excludes URL-less rows, so the serviceId test only ever
 *    removed monitorable services. It is GONE — default pods are pinged.
 *  • A row with no `webhookUrl` genuinely cannot be pinged. It is now returned
 *    as `unmonitored` and RECORDED as such, instead of being dropped.
 *
 * Pure + exported so the classification is unit-testable without HTTP or a DB.
 */
export function classifyServicesForHealthCheck(
  services: HealthCheckCandidate[]
): {
  pingable: PingableService[];
  unmonitored: HealthCheckCandidate[];
} {
  const monitored = services.filter((s) =>
    MONITORED_STATUSES.has(s.status ?? "")
  );
  return {
    pingable: monitored.filter((s): s is PingableService =>
      Boolean(s.webhookUrl)
    ),
    unmonitored: monitored.filter((s) => !s.webhookUrl),
  };
}

/** A candidate proven to carry a URL — the only thing `pingService` accepts. */
export type PingableService = HealthCheckCandidate & { webhookUrl: string };

/**
 * Called by the cron scheduler every 2 minutes.
 * Pings every enabled, monitorable service — and records the un-pingable ones.
 */
export async function handleIntelligenceHealthCheck(): Promise<void> {
  const services = await db.query.intelligenceServices.findMany({
    where: eq(intelligenceServices.enabled, true),
    columns: {
      id: true,
      serviceId: true,
      name: true,
      webhookUrl: true,
      status: true,
      // Carries the alert's 6h dedup watermark (connectionHealth.<key>).
      metadata: true,
    },
  });

  const { pingable, unmonitored } = classifyServicesForHealthCheck(
    services as HealthCheckCandidate[]
  );

  // Stamp the un-pingable ones so they read "unmonitored" on every surface that
  // renders `lastHealthStatus`, instead of keeping a stale green verdict (or no
  // verdict at all, which the pod-admin card painted as "Not pinged" only by
  // accident). This is the whole fix: silent absence must not read as health.
  if (unmonitored.length > 0) {
    const checkedAt = new Date();
    for (const svc of unmonitored) {
      await db
        .update(intelligenceServices)
        .set({
          lastHealthCheck: checkedAt,
          lastHealthStatus: "unmonitored",
          updatedAt: checkedAt,
        })
        .where(eq(intelligenceServices.id, svc.id));
    }
    logger.warn(
      {
        count: unmonitored.length,
        serviceIds: unmonitored.map((s) => s.serviceId),
      },
      "Intelligence services have no webhookUrl — NOT health-monitored"
    );
  }

  if (pingable.length === 0) {
    logger.debug(
      { unmonitored: unmonitored.length },
      "No pingable intelligence services"
    );
    return;
  }

  logger.debug(
    { count: pingable.length },
    "Running intelligence service health checks"
  );

  const results = await Promise.allSettled(
    pingable.map(async (svc) => {
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
      // The LIFECYCLE column moves to "expiring" so the frontend can warn —
      // but NEVER for the default service. `resolveDefaultIntelligenceEndpoint`
      // resolves the pod's IS endpoint with `status IN ('active',
      // 'credential_error')`; flipping the default row to "expiring" would drop
      // the pod to its env-var fallback (usually wrong) as a side effect of a
      // health check. The `lastHealthStatus` verdict below still records
      // "expiring", so the signal is visible without moving routing.
      const moveLifecycle =
        effectiveStatus === "expiring" && svc.serviceId !== "default";
      await db
        .update(intelligenceServices)
        .set({
          lastHealthCheck: checkedAt,
          lastHealthStatus: effectiveStatus,
          updatedAt: checkedAt,
          ...(moveLifecycle ? { status: "expiring" } : {}),
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

  // `unmonitored` is carried into BOTH branches on purpose: a summary that says
  // "all healthy" while N services are unwatched is the exact lie this worker
  // used to tell.
  if (unhealthy > 0 || degraded > 0) {
    logger.warn(
      {
        healthy,
        degraded,
        unhealthy,
        unmonitored: unmonitored.length,
        total: pingable.length,
      },
      "Intelligence service health check: some services are unhealthy"
    );
  } else {
    logger.debug(
      { healthy, unmonitored: unmonitored.length, total: pingable.length },
      "Intelligence service health check: all pinged services healthy"
    );
  }
}
