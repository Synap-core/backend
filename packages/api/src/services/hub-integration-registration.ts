/**
 * Hub integration registration — shared mint/revoke policy for:
 * - POST /api/hub/setup/agent (agent user + hub_inbound key)
 * - apiKeys.connectIntegration (human user + hub_inbound key)
 *
 * Keeps prefix choice, plaintext generation, scope tables, and revoke-then-mint
 * in one place so CP machine setup and admin UI flows stay aligned.
 */

import { randomBytes } from "crypto";
import type { ApiKeyRepository, CreateApiKeyInput } from "@synap/database";
import { and, eq } from "@synap/database";
import type { db } from "@synap/database";
import { apiKeys } from "@synap/database/schema";

/** Default scopes for externally provisioned agents via setup/agent.
 *
 * `realtime:observe` is included so every agent provisioned through this path
 * (Eve, OpenClaw, etc.) can subscribe to the Socket.IO `/presence`
 * namespace using its API key. This is the load-bearing scope for Phase 3A
 * of the Eve OS vision — the channels viz subscribes to workspace event
 * broadcasts using the `eve` agent's key. Read-only; emitting events back
 * still requires the BRIDGE_SECRET on the HTTP bridge endpoint.
 */
export const SETUP_AGENT_HUB_SCOPES = [
  "hub-protocol.read",
  "hub-protocol.write",
  "mcp.read",
  "mcp.write",
  "realtime:observe",
  "chat.stream",
] as const;

/**
 * Lifetime for agent hub keys minted via POST /api/hub/setup/agent.
 *
 * SAFE (non-bricking) default: 90 days matches the `rotationScheduledAt`
 * horizon the service layer already uses and, paired with the near-expiry
 * warning headers emitted by the inbound auth middleware
 * (KEY_EXPIRY_WARNING_DAYS in hub-protocol-rest.ts), gives the caller ample
 * lead time to re-provision before a hard 401.
 *
 * Do NOT drop this to 30d until auto-rotation+propagation is VERIFIED: rotating
 * a live hub key mints a NEW plaintext that is NOT pushed to wherever the IS /
 * agent stores its credential, so a bare 30d TTL with no propagation would 401
 * every agent 30 days out. Only new mints get an expiry — existing keys are
 * never retroactively expired.
 *
 * TODO: tighten to 30d once auto-rotation+propagation is dogfooded.
 */
export const AGENT_KEY_TTL_DAYS = 90;

/**
 * Schedule an agent key for rotation this many days BEFORE it expires, so the
 * rotation-check cron (packages/jobs) flags it while the key is still valid
 * rather than after it has already bricked.
 */
export const AGENT_KEY_ROTATION_LEAD_DAYS = 14;

/** Scopes granted per integration type (admin /connect UI).
 *
 * All integrations get `mcp.read` + `mcp.write` so the issued key can drive
 * the pod's /mcp endpoint end-to-end. MCP tool dispatch gates on these scopes
 * (see `packages/api/src/routers/mcp/tools/index.ts`); without them tool
 * calls return -32603 "Tool '...' requires scope 'mcp.read'" and clients
 * like Claude Desktop surface this as a generic "not responding" timeout.
 *
 * Matches `SETUP_AGENT_HUB_SCOPES` above — the two paths now issue keys
 * with the same capability surface, differing only in audit tagging.
 */
export const INTEGRATION_HUB_SCOPES: Record<string, string[]> = {
  // cli gets everything SETUP_AGENT_HUB_SCOPES grants, plus data access
  cli: [...SETUP_AGENT_HUB_SCOPES, "data.read", "data.write"],
  raycast: [
    "hub-protocol.read",
    "hub-protocol.write",
    "mcp.read",
    "mcp.write",
    "data.read",
  ],
  openclaw: [
    "hub-protocol.read",
    "hub-protocol.write",
    "mcp.read",
    "mcp.write",
    "data.read",
  ],
  custom: ["hub-protocol.read", "hub-protocol.write", "mcp.read", "mcp.write"],
};

export function getHubInboundKeyPrefix(): string {
  return process.env.NODE_ENV === "production"
    ? "synap_hub_live_"
    : "synap_hub_test_";
}

export function generateHubInboundPlainKey(prefix?: string): string {
  const p = prefix ?? getHubInboundKeyPrefix();
  return `${p}${randomBytes(32).toString("hex")}`;
}

export function integrationHubId(integration: string): string {
  return `integration:${integration}`;
}

export function integrationHubIdFromIssuerUrl(jwtIssuerUrl: string): string {
  return `integration:${new URL(jwtIssuerUrl).hostname}`;
}

/**
 * Revoke all active hub_inbound keys for a user (used before re-provisioning
 * an agent key in setup/agent).
 */
export async function revokeActiveHubInboundKeysForUser(
  database: typeof db,
  params: { userId: string; revokedBy: string; revokedReason: string }
): Promise<void> {
  await database
    .update(apiKeys)
    .set({
      isActive: false,
      revokedAt: new Date(),
      revokedBy: params.revokedBy,
      revokedReason: params.revokedReason,
    })
    .where(
      and(
        eq(apiKeys.userId, params.userId),
        eq(apiKeys.keyType, "hub_inbound"),
        eq(apiKeys.isActive, true)
      )
    );
}

/**
 * Create a hub_inbound key via ApiKeyRepository with shared prefix/plaintext rules.
 */
export async function mintHubInboundKey(
  apiKeyRepo: ApiKeyRepository,
  input: Omit<CreateApiKeyInput, "key" | "keyPrefix"> & {
    keyPrefix?: string;
    plainKey?: string;
  },
  createdByUserId: string
): Promise<{
  apiKey: Awaited<ReturnType<ApiKeyRepository["create"]>>;
  plainKey: string;
}> {
  const keyPrefix = input.keyPrefix ?? getHubInboundKeyPrefix();
  const plainKey = input.plainKey ?? generateHubInboundPlainKey(keyPrefix);
  const { plainKey: _dropPlain, keyPrefix: _dropPrefix, ...rest } = input;
  const apiKey = await apiKeyRepo.create(
    {
      ...rest,
      keyPrefix,
      key: plainKey,
    },
    createdByUserId
  );
  return { apiKey, plainKey };
}
