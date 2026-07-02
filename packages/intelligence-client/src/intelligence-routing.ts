/**
 * Intelligence Service Routing Helper
 *
 * Determines which intelligence service to use, in precedence order:
 * 0. Capability-first (a service advertising the requested capability)
 * 1. Workspace preference (if in workspace context)
 * 2. User preference (capability-specific or default)
 * 3. Pod default (the `is_default` service)
 * 4. Failover (any active+enabled service with a real key)
 * 5. Fallback to the environment-variable service
 */

import { db, eq, and, drizzleSql } from "@synap/database";
import {
  userPreferences,
  workspaces,
  intelligenceServices,
  users,
  workspaceMembers,
  agents,
} from "@synap/database/schema";
import { IntelligenceHubClient } from "./intelligence-hub-client.js";
import { resolveServiceKey } from "@synap/database";
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
  [key: string]: unknown;
}

export interface ServiceResolutionContext {
  /** Optional — omit for pod-level/background resolution (no user context). */
  userId?: string;
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
 * Resolve which intelligence service (agent) to use.
 * @alias resolveAgent
 */
export async function resolveIntelligenceService(
  ctx: ServiceResolutionContext = {}
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
    logger.debug({ capability }, "Step 0: Checking capability-first routing");
    const capService = await db.query.intelligenceServices.findFirst({
      where: and(
        drizzleSql`${intelligenceServices.status} IN ('active', 'credential_error')`,
        eq(intelligenceServices.enabled, true),
        drizzleSql`${intelligenceServices.capabilities} @> ${JSON.stringify([capability])}::jsonb`
      ),
    });
    if (capService) {
      logger.info(
        {
          capability,
          serviceId: capService.serviceId,
          url: capService.webhookUrl,
        },
        "IS resolved via capability-first routing"
      );
      return { ...createClient(capService), agentUserId };
    }
    logger.debug(
      { capability },
      "Step 0: No service found with requested capability"
    );
  }

  // 1. Check workspace preference (if in workspace)
  if (ctx.workspaceId) {
    logger.debug(
      { workspaceId: ctx.workspaceId },
      "Step 1: Checking workspace preference"
    );
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
      if (service) {
        logger.info(
          {
            serviceId: wsServiceId,
            url: service.webhookUrl,
            source: "workspace_preference",
          },
          "IS resolved via workspace preference"
        );
        return { ...createClient(service), agentUserId };
      }
      logger.debug(
        { wsServiceId },
        "Step 1: Workspace service not active/found"
      );
    } else {
      logger.debug(
        { workspaceId: ctx.workspaceId },
        "Step 1: No workspace IS preference set"
      );
    }
  }

  // 2. Check user preferences
  logger.debug({ userId: ctx.userId }, "Step 2: Checking user preferences");
  const userPrefs = ctx.userId
    ? await db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, ctx.userId),
      })
    : undefined;

  const userServicePrefs =
    (userPrefs?.intelligenceServicePreferences as
      | Record<string, string>
      | undefined) || {};
  const userServiceId =
    userServicePrefs[capability] || userServicePrefs.default;

  if (userServiceId) {
    const service = await getActiveService(userServiceId);
    if (service) {
      logger.info(
        {
          serviceId: userServiceId,
          url: service.webhookUrl,
          source: "user_preference",
        },
        "IS resolved via user preference"
      );
      return { ...createClient(service), agentUserId };
    }
    logger.debug(
      { userServiceId },
      "Step 2: User-preferred service not active/found"
    );
  } else {
    logger.debug({ userId: ctx.userId }, "Step 2: No user IS preference set");
  }

  // 3. Pod default: the explicitly SELECTED default IS (the `is_default` flag) —
  //    the "switch" target, the pod's chosen agent service when no workspace/user
  //    preference applies (background jobs, pod-level calls).
  logger.debug("Step 3: Checking the pod's selected default IS (is_default)");
  const selectedDefault = await db.query.intelligenceServices.findFirst({
    where: and(
      eq(intelligenceServices.isDefault, true),
      drizzleSql`${intelligenceServices.status} IN ('active', 'credential_error')`,
      eq(intelligenceServices.enabled, true)
    ),
  });
  if (selectedDefault) {
    // Skip a placeholder-key default: replica pods stamp synced rows with
    // SYNC_PLACEHOLDER (the real key is per-pod). Without this guard an
    // is_default placeholder row would short-circuit the failover's own real-key
    // check below and send a dead key → guaranteed 401.
    const hasRealKey =
      !!selectedDefault.apiKey &&
      selectedDefault.apiKey !== "SYNC_PLACEHOLDER" &&
      selectedDefault.apiKey.length > 0;
    if (hasRealKey) {
      logger.info(
        { serviceId: selectedDefault.serviceId, source: "is_default" },
        "IS resolved via the pod's selected default (is_default)"
      );
      return { ...createClient(selectedDefault), agentUserId };
    }
    logger.debug(
      { serviceId: selectedDefault.serviceId },
      "Step 3: is_default service has a placeholder key — falling through to failover"
    );
  }

  // 4. Failover: if no service matched so far, check if ANY active+enabled service
  //    exists in the DB (e.g. synced from the primary pod via supplementary sync).
  //    This covers replica pods that received IS metadata via sync but whose preferred
  //    service lookup in steps 1-2 didn't match (no workspace/user preference set).
  logger.debug(
    "Step 4: Checking for any active intelligence service (failover)"
  );
  const anyActiveService = await db.query.intelligenceServices.findFirst({
    where: and(
      drizzleSql`${intelligenceServices.status} IN ('active', 'credential_error')`,
      eq(intelligenceServices.enabled, true)
    ),
    orderBy: (t, { desc }) => [desc(t.updatedAt)],
  });

  if (anyActiveService) {
    // Verify credentials are real (not a sync placeholder)
    const hasRealKey =
      anyActiveService.apiKey &&
      anyActiveService.apiKey !== "SYNC_PLACEHOLDER" &&
      anyActiveService.apiKey.length > 0;

    if (hasRealKey) {
      logger.info(
        {
          serviceId: anyActiveService.serviceId,
          url: anyActiveService.webhookUrl,
          source: "failover_any_active",
        },
        "IS resolved via failover — using first active service"
      );
      return { ...createClient(anyActiveService), agentUserId };
    }

    logger.debug(
      { serviceId: anyActiveService.serviceId },
      "Step 4: Found synced service but credentials are placeholder — falling through to env"
    );
  }

  // 5. Fallback to default service from environment
  logger.debug(
    "Step 5: No DB-registered service matched — falling back to env default"
  );
  const defaultService = createDefaultClient();
  logger.info(
    {
      url: defaultService.endpoint,
      source: "env_fallback",
      hasKey: !!defaultService.serviceApiKey,
    },
    "IS resolved via environment fallback"
  );
  return { ...defaultService, agentUserId };
}

/**
 * Find the dedicated AI agent user for a given human user+workspace pair.
 * Returns undefined if no agent user exists (graceful degradation).
 */
async function lookupAgentUser(
  userId: string | undefined,
  workspaceId?: string
): Promise<string | undefined> {
  if (!userId || !workspaceId) return undefined;
  try {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
      .where(
        and(
          eq(users.userType, "agent"),
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(users.createdByUserId, userId)
        )
      )
      .limit(1);
    return row?.id;
  } catch {
    // Agent user lookup is non-critical; degrade gracefully
    return undefined;
  }
}

/** Timeout for service resolution DB queries — prevents hangs during chat triggers */
const SERVICE_RESOLUTION_TIMEOUT_MS = 5_000;

/**
 * Get active service by ID.
 * Returns null if the service is known-unhealthy (skip routing to it),
 * or if the DB query times out (fail open → route to fallback).
 */
async function getActiveService(serviceId: string) {
  // Include "credential_error" services — the key may have been refreshed on
  // the IS side since the last probe. If the key is still bad, the IS will
  // return 401 and the circuit breaker handles it. Excluding these services
  // causes a silent fallback to env vars which are often misconfigured,
  // producing misleading "overload" errors instead of actionable credential errors.
  const queryPromise = db.query.intelligenceServices.findFirst({
    where: and(
      eq(intelligenceServices.serviceId, serviceId),
      drizzleSql`${intelligenceServices.status} IN ('active', 'credential_error')`,
      eq(intelligenceServices.enabled, true)
    ),
  });

  const svc = await Promise.race([
    queryPromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`getActiveService(${serviceId}) timed out`)),
        SERVICE_RESOLUTION_TIMEOUT_MS
      )
    ),
  ]).catch((err) => {
    logger.warn(
      { serviceId, err: err instanceof Error ? err.message : String(err) },
      "Service resolution timed out or failed — falling through to default"
    );
    return null;
  });
  if (!svc) return null;
  // Skip explicitly unhealthy services — route to fallback instead
  if ((svc as { lastHealthStatus?: string }).lastHealthStatus === "unhealthy") {
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
/** Service record shape expected by createClient — non-null string fields after Drizzle nullable inference */
interface ServiceRecord {
  serviceId: string;
  webhookUrl: string;
  apiKey: string | null;
  mcpEndpoint: string | null;
  mcpApproved: boolean | null;
  lastHealthCheck: Date | string | null;
}

function createClient(service: ServiceRecord): ResolvedService {
  const apiKey = resolveServiceKey(service.apiKey ?? "");

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

/** @alias resolveIntelligenceService */
export const resolveAgent = resolveIntelligenceService;

/**
 * Resolve IS by agentId — looks up agents.intelligenceServiceId FK to find the
 * exact IS that owns this agent. Falls back to resolveIntelligenceService() when
 * the agent is local (no intelligenceServiceId) or not found.
 */
export async function resolveIntelligenceServiceByAgentId(
  agentId: string,
  ctx: ServiceResolutionContext
): Promise<ResolvedService> {
  try {
    const [agent] = await db
      .select({ intelligenceServiceId: agents.intelligenceServiceId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.active, true)))
      .limit(1);

    if (agent?.intelligenceServiceId) {
      const service = await getActiveService(agent.intelligenceServiceId);
      if (service) {
        const agentUserId = await lookupAgentUser(ctx.userId, ctx.workspaceId);
        logger.info(
          { agentId, serviceId: service.serviceId },
          "IS resolved via agent → intelligenceServiceId"
        );
        return { ...createClient(service), agentUserId };
      }
    }
  } catch (err) {
    logger.warn(
      { agentId, err },
      "Agent→IS lookup failed, falling back to workspace routing"
    );
  }

  return resolveIntelligenceService(ctx);
}

/**
 * Return the endpoint + API key for the first active registered intelligence service,
 * falling back to env vars. Useful for fire-and-forget callers that don't have
 * full user/workspace context (e.g. proposal telemetry).
 */
export async function getDefaultActiveService(): Promise<{
  endpoint: string;
  apiKey: string;
}> {
  // Thin facade over the ONE canonical resolver. Callers just ask for "the IS";
  // resolveIntelligenceService() decides (capability → workspace → user →
  // is_default → any active → env). No separate resolution logic lives here.
  //
  // MUST NOT THROW: the fire-and-forget callers (proposal telemetry, mail-feed
  // triage, background jobs) don't all guard this call, and a corrupted or
  // undecryptable stored key makes resolveServiceKey()/createClient() throw.
  // Degrade to the env client on any failure — the same never-throw contract
  // this had before the resolver consolidation.
  try {
    const svc = await resolveIntelligenceService();
    return { endpoint: svc.endpoint, apiKey: svc.serviceApiKey };
  } catch (err) {
    logger.warn(
      { err },
      "getDefaultActiveService: resolver threw — degrading to env fallback"
    );
    const ep = createDefaultClient();
    return { endpoint: ep.endpoint, apiKey: ep.serviceApiKey };
  }
}

/**
 * Switch the pod's default intelligence service — the "use any IS you want"
 * selector. Clears the previous default and marks `serviceId` as the sole default
 * (the partial-unique index enforces one). This is what the canonical resolver
 * picks when no workspace/user preference applies.
 */
export async function setDefaultIntelligenceService(
  serviceId: string
): Promise<void> {
  await db.transaction(async (tx) => {
    // Verify the target exists BEFORE clearing the current default — otherwise a
    // stale/typo serviceId would clear the default and set nothing, silently
    // leaving the pod with no default at all.
    const [target] = await tx
      .select({ id: intelligenceServices.id })
      .from(intelligenceServices)
      .where(eq(intelligenceServices.serviceId, serviceId))
      .limit(1);
    if (!target) {
      throw new Error(`Intelligence service "${serviceId}" not found`);
    }
    await tx
      .update(intelligenceServices)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(intelligenceServices.isDefault, true));
    await tx
      .update(intelligenceServices)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(intelligenceServices.serviceId, serviceId));
  });
}

/**
 * Create default client from environment.
 */
function createDefaultClient(): ResolvedService {
  const baseUrl = process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002";
  return {
    serviceId: "default",
    endpoint: baseUrl,
    client: new IntelligenceHubClient(baseUrl, ""),
    serviceApiKey: "",
  };
}
