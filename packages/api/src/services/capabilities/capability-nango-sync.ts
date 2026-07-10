/**
 * Nango → connection-registry reconciler.
 *
 * A Nango OAuth connection's credential lives in Nango, NOT the vault — so it is
 * never written to `secrets` by the connect flow, and therefore never appears in
 * the capability's connection registry (`listConnections`) nor becomes pickable
 * by the run-time `connectionSelector`. This module closes that gap: for a
 * capability whose tool(s) use the `nango://` scheme, it mirrors the user's live
 * Nango connections into `secrets` POINTER rows — one row per Nango connection,
 * carrying `provider_integration_id` (routes execution back through the Nango
 * proxy) and `account_hint` (which Nango connection it represents). The row holds
 * no real key (an empty encrypted blob), because the credential stays in Nango.
 *
 * It is a RECONCILER, not a one-shot: called lazily from `listConnections`, it
 * both BACKFILLS pre-existing connections and stays fresh as new ones appear.
 * Idempotent (dedupes on `account_hint`) and BEST-EFFORT (a Nango outage must
 * never break the list — callers swallow its errors).
 */

import {
  db,
  and,
  eq,
  isNull,
  inArray,
  like,
  encryptServerSide,
} from "@synap/database";
import { links, tools, secrets } from "@synap/database/schema";

import { resolveNangoConnector } from "../../connectors/index.js";

/** `nango://gmail` / a tool config → the Nango providerConfigKey. */
function providerConfigKeyOf(tool: {
  credentialRef: string | null;
  config: unknown;
}): string | null {
  const cfg = (tool.config ?? {}) as Record<string, unknown>;
  if (typeof cfg.providerConfigKey === "string") return cfg.providerConfigKey;
  if (tool.credentialRef?.startsWith("nango://"))
    return tool.credentialRef.replace(/^nango:\/\//, "");
  return null;
}

/**
 * Mirror the actor's live Nango connections for `capabilityId` into `secrets`
 * pointer rows. Returns silently on any failure (best-effort backfill/refresh).
 */
export async function syncNangoConnectionsToRegistry(
  capabilityId: string,
  actorUserId: string
): Promise<void> {
  // 1. The capability's member tools that use the nango:// scheme.
  const edges = await db
    .select({ toolId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.toType, "capability"),
        eq(links.toId, capabilityId),
        eq(links.linkType, "member_of"),
        eq(links.fromType, "tool")
      )
    );
  const toolIds = edges.map((e) => e.toolId);
  if (toolIds.length === 0) return;

  const nangoTools = await db
    .select({ credentialRef: tools.credentialRef, config: tools.config })
    .from(tools)
    .where(
      and(inArray(tools.id, toolIds), like(tools.credentialRef, "nango://%"))
    );
  if (nangoTools.length === 0) return; // pure-vault capability — nothing to sync.

  const providerKeys = Array.from(
    new Set(nangoTools.map(providerConfigKeyOf).filter((k): k is string => !!k))
  );
  if (providerKeys.length === 0) return;

  const connector = await resolveNangoConnector();
  if (!connector) return; // Nango unconfigured — leave the registry untouched.

  // 2. Existing registry rows for this (capability, actor) — dedup + default gate.
  const existing = await db
    .select({
      accountHint: secrets.accountHint,
      isDefault: secrets.isDefault,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.capabilityId, capabilityId),
        eq(secrets.userId, actorUserId),
        isNull(secrets.deletedAt)
      )
    );
  const known = new Set(
    existing.map((r) => r.accountHint).filter((h): h is string => !!h)
  );
  let needsDefault = !existing.some((r) => r.isDefault);

  // 3. Live Nango connections for the actor, filtered to this capability's providers.
  const liveConnections = await connector.listConnections(actorUserId);

  for (const providerConfigKey of providerKeys) {
    const matches = liveConnections.filter(
      (c) => c.provider === providerConfigKey
    );
    for (const conn of matches) {
      if (known.has(conn.connectionId)) continue; // already mirrored.

      // Only the FIRST mirrored connection (when no default exists) claims the
      // default slot — respects idx_secrets_capability_default (one per capability).
      const makeDefault = needsDefault;
      needsDefault = false;
      known.add(conn.connectionId);

      // A pure POINTER row: no stored credential (empty blob — the credential
      // stays in Nango) and NO provider_integration_id. `account_hint` = the Nango
      // connectionId; at run time the selector keeps the tool's own nango:// ref
      // and pins THIS account via the hint (see external-dispatch). This works
      // against the live nango:// tools without needing a provider_integrations row.
      const blob = encryptServerSide("");
      await db.insert(secrets).values({
        userId: actorUserId,
        workspaceId: null,
        name: `${providerConfigKey} · ${conn.connectionId.slice(-6)}`,
        type: "api_key",
        capabilityId,
        accountHint: conn.connectionId,
        isDefault: makeDefault,
        encryptedData: blob.encryptedData,
        iv: blob.iv,
        authTag: blob.authTag,
        encryptionVersion: 1,
        encryptionMode: "server",
      });
    }
  }
}
