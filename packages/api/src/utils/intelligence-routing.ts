/**
 * Intelligence Service Routing Helper
 *
 * Determines which intelligence service to use based on:
 * 1. Workspace preferences (if in workspace context)
 * 2. User preferences (capability-specific or default)
 * 3. Fallback to environment variable service
 */

import { db, eq, and, sql } from "@synap/database";
import {
  userPreferences,
  workspaces,
  intelligenceServices,
  users,
  workspaceMembers,
} from "@synap/database/schema";
import { IntelligenceHubClient } from "../clients/intelligence-hub.js";

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
  capability?: "chat" | "analysis" | "default";
}

export interface ResolvedService {
  serviceId: string;
  endpoint: string;
  client: IntelligenceHubClient;
  /** Per-human AI agent user ID, if one exists for this user+workspace pair */
  agentUserId?: string;
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
          sql`${users.agentMetadata}->>'createdByUserId' = ${userId}`
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
 * Get active service by ID
 */
async function getActiveService(serviceId: string) {
  return db.query.intelligenceServices.findFirst({
    where: and(
      eq(intelligenceServices.serviceId, serviceId),
      eq(intelligenceServices.status, "active"),
      eq(intelligenceServices.enabled, true)
    ),
  });
}

/**
 * Create client from service record
 */
function createClient(service: any): ResolvedService {
  return {
    serviceId: service.serviceId,
    endpoint: service.webhookUrl,
    client: new IntelligenceHubClient(service.webhookUrl),
  };
}

/**
 * Create default client from environment
 */
function createDefaultClient(): ResolvedService {
  const baseUrl = process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002";
  return {
    serviceId: "default",
    endpoint: baseUrl,
    client: new IntelligenceHubClient(baseUrl),
  };
}
