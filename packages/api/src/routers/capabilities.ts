/**
 * Capabilities Router
 *
 * Discovers what features and intelligence services are available.
 * Frontend SDK calls this to dynamically adapt UI.
 *
 * Health model:
 *   - `list` returns cached lastHealthCheck from DB (fast, always available)
 *   - `checkHealth` pings a specific service and updates DB (called async by UI)
 *   - `serviceUsageStats` aggregates message counts by serviceId from messages JSONB
 */

import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import { db, intelligenceServices, eq, drizzleSql } from "@synap/database";
import { MessageAuthorType } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "capabilities" });

/** Default (proprietary) Synap Intelligence service — always available when no custom service is configured. */
const DEFAULT_INTELLIGENCE_SERVICE = {
  id: "default",
  serviceId: "default",
  name: "Synap Intelligence",
  capabilities: [
    "chat",
    "analysis",
    "commands",
    "proposals",
    "threads",
  ] as string[],
  pricing: "free" as const,
  version: "1.0",
  webhookUrl: null as string | null,
  lastHealthCheck: null as Date | null,
};

// ─── Health check helper ──────────────────────────────────────────────────────

async function pingServiceHealth(webhookUrl: string): Promise<boolean> {
  try {
    const healthUrl = `${webhookUrl.replace(/\/+$/, "")}/health`;
    const res = await fetch(healthUrl, {
      signal: AbortSignal.timeout(5000),
      method: "GET",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const capabilitiesRouter = router({
  /**
   * List all available capabilities.
   *
   * Returns core features, plugins, and intelligence services with cached
   * health status (lastHealthCheck). Does NOT ping services — use checkHealth
   * for that so this query stays fast.
   */
  list: publicProcedure.query(async () => {
    logger.debug("Listing capabilities");

    const plugins: Array<{ name: string; version: string; enabled: boolean }> =
      [];

    // Include health-check columns
    const dbServices = await db.query.intelligenceServices.findMany({
      where: eq(intelligenceServices.status, "active"),
      columns: {
        id: true,
        serviceId: true,
        name: true,
        capabilities: true,
        pricing: true,
        version: true,
        webhookUrl: true,
        lastHealthCheck: true,
        lastHealthStatus: true,
      },
    });

    const hasDefault = dbServices.some((s) => s.serviceId === "default");
    const services = hasDefault
      ? dbServices
      : [DEFAULT_INTELLIGENCE_SERVICE, ...dbServices];

    return {
      core: {
        version: "1.0.0",
        features: [
          "notes",
          "tasks",
          "chat",
          "entities",
          "events",
          "files",
          "inbox",
        ],
      },
      plugins,
      intelligenceServices: services.map((s) => ({
        id: s.id,
        serviceId: s.serviceId,
        name: s.name,
        capabilities: s.capabilities,
        pricing: s.pricing || "free",
        version: s.version,
        webhookUrl: s.webhookUrl ?? null,
        lastHealthCheck: s.lastHealthCheck ?? null,
        lastHealthStatus: (s as any).lastHealthStatus ?? null,
      })),
    };
  }),

  /**
   * Ping a specific intelligence service's /health endpoint.
   * Updates lastHealthCheck in DB and returns the health result.
   * Call this asynchronously from the UI — do NOT await on first paint.
   */
  checkHealth: protectedProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ input }) => {
      // Built-in default service: cannot be pinged (same process)
      if (input.serviceId === "default") {
        return { serviceId: "default", isHealthy: true, checkedAt: new Date() };
      }

      const svc = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, input.serviceId),
        columns: { id: true, webhookUrl: true },
      });

      if (!svc) {
        return {
          serviceId: input.serviceId,
          isHealthy: false,
          checkedAt: new Date(),
        };
      }

      const isHealthy = await pingServiceHealth(svc.webhookUrl);
      const checkedAt = new Date();

      await db
        .update(intelligenceServices)
        .set({
          lastHealthCheck: checkedAt,
          lastHealthStatus: isHealthy ? "healthy" : "unhealthy",
          updatedAt: checkedAt,
        })
        .where(eq(intelligenceServices.id, svc.id));

      logger.debug(
        { serviceId: input.serviceId, isHealthy },
        "Health check complete"
      );
      return { serviceId: input.serviceId, isHealthy, checkedAt };
    }),

  /**
   * Usage statistics per intelligence service.
   * Aggregates message counts + token usage from the messages table JSONB.
   *
   * Returns per-service stats for the given period (default: last 30 days).
   */
  serviceUsageStats: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        days: z.number().min(1).max(365).default(30),
      })
    )
    .query(async ({ input }) => {
      const since = new Date();
      since.setDate(since.getDate() - input.days);

      // Query: group by metadata->>'serviceId', count messages and sum tokens
      const rows = await db.execute(
        drizzleSql`
          SELECT
            COALESCE(metadata->>'serviceId', 'default') AS service_id,
            COUNT(*)::int                               AS message_count,
            SUM(COALESCE((metadata->>'tokens')::int, 0))::int AS total_tokens,
            AVG(COALESCE((metadata->>'latency')::float, 0))::float AS avg_latency_ms
          FROM messages
          WHERE author_type = ${MessageAuthorType.AI_AGENT}
            AND timestamp  >= ${since}
            AND deleted_at IS NULL
          GROUP BY service_id
          ORDER BY message_count DESC
        `
      );

      const stats = (
        rows as unknown as Array<{
          service_id: string;
          message_count: number;
          total_tokens: number;
          avg_latency_ms: number;
        }>
      ).map((r) => ({
        serviceId: r.service_id,
        messageCount: Number(r.message_count),
        totalTokens: Number(r.total_tokens),
        avgLatencyMs: Math.round(Number(r.avg_latency_ms)),
      }));

      return { stats, since: since.toISOString(), days: input.days };
    }),

  /**
   * Check if a specific capability is available.
   */
  hasCapability: publicProcedure
    .input(z.object({ capability: z.string() }))
    .query(async ({ input }) => {
      const dbServices = await db.query.intelligenceServices.findMany({
        where: eq(intelligenceServices.status, "active"),
      });

      const hasDefaultCapability =
        DEFAULT_INTELLIGENCE_SERVICE.capabilities.includes(input.capability);
      const hasDbCapability = dbServices.some((s) =>
        (s.capabilities as string[]).includes(input.capability)
      );

      return { available: hasDefaultCapability || hasDbCapability };
    }),
});
