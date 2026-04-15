/**
 * Hub integration registration — shared mint/revoke policy for:
 * - POST /api/hub/setup/agent (agent user + hub_inbound key)
 * - apiKeys.connectIntegration (human user + hub_inbound key)
 *
 * Keeps prefix choice, plaintext generation, scope tables, and revoke-then-mint
 * in one place so CP machine setup and admin UI flows stay aligned.
 */

import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import type { ApiKeyRepository, CreateApiKeyInput } from "@synap/database";
import { db } from "@synap/database";
import { apiKeys } from "@synap/database/schema";

/** Default scopes for externally provisioned agents via setup/agent */
export const SETUP_AGENT_HUB_SCOPES = [
  "hub-protocol.read",
  "hub-protocol.write",
  "mcp.read",
  "mcp.write",
] as const;

/** Scopes granted per integration type (admin /connect UI) */
export const INTEGRATION_HUB_SCOPES: Record<string, string[]> = {
  raycast: ["hub-protocol.read", "hub-protocol.write", "data.read"],
  cli: ["hub-protocol.read", "hub-protocol.write", "data.read", "data.write"],
  openclaw: [
    "hub-protocol.read",
    "hub-protocol.write",
    "mcp.connect",
    "data.read",
  ],
  custom: ["hub-protocol.read", "hub-protocol.write"],
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
