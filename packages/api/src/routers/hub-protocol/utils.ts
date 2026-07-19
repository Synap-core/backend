/**
 * Hub Protocol Utilities
 *
 * Shared utilities for creating tRPC callers to regular API endpoints
 */

import { getDb } from "@synap/database";
import type { Context } from "../../types/context.js";
import { resolveConfinedWorkspace } from "./confine-workspace.js";

/**
 * Create a tRPC caller context for Hub Protocol
 * This allows Hub Protocol to call regular API endpoints programmatically.
 * When calling workspace-scoped procedures (e.g. entities create/update),
 * pass workspaceId so the same event chain and validation apply.
 *
 * SERVICE-KEY CONFINEMENT (Item 3): when the authenticating key is a bound
 * `service` key, `keyType`/`keyWorkspaceId` (from the auth middleware) pin the
 * effective `ctx.workspaceId` to the key's workspace via
 * {@link resolveConfinedWorkspace} — this is the SHARED DOOR that confines every
 * handler routing through it. Non-service (legacy) keys pass through unchanged.
 * Callers that don't thread the two values (most direct callers today) get
 * legacy passthrough; the common `getCaller` wrapper threads them from context.
 */
export async function createHubProtocolCallerContext(
  userId: string,
  scopes: string[],
  workspaceId?: string | null,
  sourceMessageId?: string | null,
  sessionId?: string | null,
  agentUserId?: string | null,
  keyType?: string | null,
  keyWorkspaceId?: string | null
): Promise<
  Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  }
> {
  const db = await getDb();

  // Positive-pin a bound service key to its workspace (no-op for other keys).
  const confinedWorkspaceId = resolveConfinedWorkspace(
    keyType,
    keyWorkspaceId,
    workspaceId
  );

  const ctx: Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  } = {
    db,
    authenticated: true,
    userId,
    scopes,
    apiKeyId: "hub-protocol",
    apiKeyName: "Hub Protocol",
    req: undefined,
    user: null,
    session: null,
    workspaceId: confinedWorkspaceId ?? null,
    // Always brand hub-protocol delegated calls as intelligence-sourced.
    source: "intelligence",
    isHubProtocol: true,
    // The agent acting on behalf of this request (agent-key linkedUserId remap).
    // When set, downstream mutations route through the governance membrane
    // (propose instead of auto-apply); undefined for operator-driven calls.
    agentUserId: agentUserId ?? null,
    // Link proposals created during this request to the triggering message.
    sourceMessageId: sourceMessageId ?? null,
    // Link proposals created during this request to the active session.
    sessionId: sessionId ?? null,
  };

  return ctx;
}
