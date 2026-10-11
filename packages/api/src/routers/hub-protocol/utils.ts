/**
 * Hub Protocol Utilities
 *
 * Shared utilities for creating tRPC callers to regular API endpoints
 */

import { getActingAgentUserId, getDb } from "@synap/database";
import { TRPCError } from "@trpc/server";
import { agentBelongsTo } from "./agent-belongs-to.js";
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

/**
 * The agent a hub write is governed as — the ONE resolution every hub-protocol
 * tRPC router (and the automations create/trigger gate) uses instead of reading
 * `input.agentUserId` (tripwire: `__tripwires__/hub-acting-agent-from-context`).
 *
 * The AUTHENTICATED agent wins: `ctx.agentUserId` is set by api-key-auth for an
 * agent key (direct tRPC mount) and threaded by `getCaller` on the REST door;
 * then the request's acting-agent scope entered by the key-auth doors, so
 * omitting the field never turns an agent write into an ungoverned operator
 * write. Only a key that is NOT itself an agent may attribute a write to a
 * body-supplied agent (the first-party IS naming the persona it runs) — and
 * only to an agent that belongs to the key's human ({@link agentBelongsTo});
 * naming anyone else's agent is refused, never silently dropped.
 */
export async function actingAgentUserId(
  ctx: { agentUserId?: string | null; userId?: string | null },
  requested?: string | null
): Promise<string | undefined> {
  const authenticated = ctx.agentUserId ?? getActingAgentUserId();
  if (authenticated) return authenticated;
  if (!requested) return undefined;
  if (!ctx.userId || !(await agentBelongsTo(ctx.userId, requested))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This key cannot act as agent ${requested}: it is not an agent of this key's person.`,
    });
  }
  return requested;
}
