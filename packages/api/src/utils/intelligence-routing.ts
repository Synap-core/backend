/**
 * Intelligence Service Routing Helper
 *
 * Determines which intelligence service to use based on:
 * 1. Workspace preferences (if in workspace context)
 * 2. User preferences (capability-specific or default)
 * 3. Fallback to environment variable service
 */

import { db, eq, and, drizzleSql } from "@synap/database";
import {
  userPreferences,
  workspaces,
  intelligenceServices,
  users,
  workspaceMembers,
} from "@synap/database/schema";
import { IntelligenceHubClient } from "../clients/intelligence-hub.js";
import { resolveServiceKey } from "./service-key-crypto.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "intelligence-routing" });

/** Stale health check threshold: warn if last check is older than 5 minutes */
const STALE_HEALTH_CHECK_MS = 5 * 60 * 1000;

// Workspace settings interface (mirrors schema definition)
interface WorkspaceSettings {
  intelligenceServiceId?: string;
  intelligenceServiceOverrides?: {
    chat?: string;
    analysis?: string;
  };
  [key: string]: any;
}

export interface ServiceResolutionContext {
  userId: string;
  workspaceId?: string;
  /**
   * Capability hint for service selection.
   * "channels" routes to a service with the "channels" capability (e.g. OpenClaw/ZeroClaw)
   * before falling back to workspace/user preferences.
   */
  capability?: "chat" | "analysis" | "channels" | "default";
}

export interface ResolvedService {
  serviceId: string;
  endpoint: string;
  client: IntelligenceHubClient;
  /** MCP server URL exposed by this service (ZeroClaw/OpenClaw local tools) */
  mcpEndpoint?: string;
  /**
   * Whether this service's MCP endpoint has been explicitly approved for tool injection.
   * Only true when set by the control plane (trusted provisioning) or by workspace owner.
   */
  mcpApproved?: boolean;
  /** Per-human AI agent user ID, if one exists for this user+workspace pair */
  agentUserId?: string;
  /**
   * Decrypted API key for authenticating requests to the intelligence service.
   * Populated for DB-registered services; empty string for the default env service.
   * Used to pass credentials to pg-boss job payloads (internal DB only).
   */
  serviceApiKey: string;
}

/**
 * Resolve which intelligence service to use
 */
export async function resolveIntelligenceService(
  ctx: ServiceResolutionContext
): Promise<ResolvedService> {
  const capability = ctx.capability || "default";

  // Look up the dedicated AI agent user for this human+workspace (non-blocking)
  const agentUserId = await lookupAgentUser(ctx.userId, ctx.workspaceId);

  // 0. Capability-first routing: if a specific capability is requested (e.g. "channels"),
  //    find a service that explicitly advertises it before checking workspace preferences.
  //    This ensures relay traffic goes to OpenClaw/ZeroClaw, not the default IS.
  if (
    capability !== "default" &&
    capability !== "chat" &&
    capability !== "analysis"
  ) {
    const capService = await db.query.intelligenceServices.findFirst({
      where: and(
        eq(intelligenceServices.status, "active"),
        eq(intelligenceServices.enabled, true),
        drizzleSql`${intelligenceServices.capabilities} @> ${JSON.stringify([capability])}::jsonb`
      ),
    });
    if (capService) return { ...createClient(capService), agentUserId };
  }

  // 1. Check workspace preference (if in workspace)
  if (ctx.workspaceId) {
    const workspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, ctx.workspaceId),
    });

    const wsSettings = workspace?.settings as WorkspaceSettings | undefined;
    const wsOverrides = wsSettings?.intelligenceServiceOverrides as
      | Record<string, string>
      | undefined;
    const wsServiceId =
      (capability !== "default" && wsOverrides?.[capability]) ||
      wsSettings?.intelligenceServiceId;

    if (wsServiceId) {
      const service = await getActiveService(wsServiceId);
      if (service) return { ...createClient(service), agentUserId };
    }
  }

  // 2. Check user preferences
  const userPrefs = await db.query.userPreferences.findFirst({
    where: eq(userPreferences.userId, ctx.userId),
  });

  const userServicePrefs =
    (userPrefs?.intelligenceServicePreferences as
      | Record<string, string>
      | undefined) || {};
  const userServiceId =
    userServicePrefs[capability] || userServicePrefs.default;

  if (userServiceId) {
    const service = await getActiveService(userServiceId);
    if (service) return { ...createClient(service), agentUserId };
  }

  // 3. Fallback to default service from environment
  return { ...createDefaultClient(), agentUserId };
}

/**
 * Find the dedicated AI agent user for a given human user+workspace pair.
 * Returns undefined if no agent user exists (graceful degradation).
 */
async function lookupAgentUser(
  userId: string,
  workspaceId?: string
): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  try {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(
        and(
          eq(users.userType, "agent"),
          eq(workspaceMembers.workspaceId, workspaceId),
          drizzleSql`${users.agentMetadata}->>'createdByUserId' = ${userId}`
        )
      )
      .limit(1);
    return row?.id;
  } catch {
    // Agent user lookup is non-critical; degrade gracefully
    return undefined;
  }
}

/**
 * Get active service by ID.
 * Returns null if the service is known-unhealthy (skip routing to it).
 */
async function getActiveService(serviceId: string) {
  const svc = await db.query.intelligenceServices.findFirst({
    where: and(
      eq(intelligenceServices.serviceId, serviceId),
      eq(intelligenceServices.status, "active"),
      eq(intelligenceServices.enabled, true)
    ),
  });
  if (!svc) return null;
  // Skip explicitly unhealthy services — route to fallback instead
  if ((svc as any).lastHealthStatus === "unhealthy") {
    logger.warn(
      { serviceId: svc.serviceId },
      "Skipping unhealthy intelligence service — falling through to next option"
    );
    return null;
  }
  return svc;
}

/**
 * Create client from service record, using the service's own API key.
 * Logs a warning if the service's last health check is stale (> 5 min).
 */
function createClient(service: any): ResolvedService {
  const apiKey = resolveServiceKey(service.apiKey as string);

  // Warn if health check timestamp is stale — the service may be unhealthy
  if (service.lastHealthCheck) {
    const ageMs = Date.now() - new Date(service.lastHealthCheck).getTime();
    if (ageMs > STALE_HEALTH_CHECK_MS) {
      logger.warn(
        { serviceId: service.serviceId, lastHealthCheckAgeMs: ageMs },
        "Routing to intelligence service with stale health check — service may be unreachable"
      );
    }
  } else {
    logger.warn(
      { serviceId: service.serviceId },
      "Routing to intelligence service with no health check on record"
    );
  }

  return {
    serviceId: service.serviceId,
    endpoint: service.webhookUrl,
    client: new IntelligenceHubClient(service.webhookUrl, apiKey),
    mcpEndpoint: service.mcpEndpoint ?? undefined,
    mcpApproved: service.mcpApproved ?? false,
    serviceApiKey: apiKey,
  };
}

/**
 * Create default client from environment
 */
function createDefaultClient(): ResolvedService {
  const baseUrl = process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002";
  const apiKey = process.env.INTELLIGENCE_HUB_API_KEY ?? "";
  return {
    serviceId: "default",
    endpoint: baseUrl,
    client: new IntelligenceHubClient(baseUrl, apiKey),
    serviceApiKey: apiKey,
  };
}
