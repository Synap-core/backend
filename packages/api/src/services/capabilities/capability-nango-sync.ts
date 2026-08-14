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
  encryptServerSide,
} from "@synap/database";
import { secrets, entityExternalLinks } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

import { resolveNangoConnector } from "../../connectors/index.js";
import { resolveCapabilityNangoProviderKeys } from "./capability-provider-resolution.js";

const logger = createLogger({ module: "capability-nango-sync" });

/**
 * Mirror the actor's live Nango connections for `capabilityId` into `secrets`
 * pointer rows. Returns silently on any failure (best-effort backfill/refresh).
 */
export async function syncNangoConnectionsToRegistry(
  capabilityId: string,
  actorUserId: string
): Promise<void> {
  // 1. The capability's Nango providers — resolved the SAME way the catalog card
  //    does (member_of tool links first, template-def fallback). Sharing this with
  //    the card + list is what stops the reconciler early-returning while the card
  //    can still see the tool via its template def.
  const providerKeys = await resolveCapabilityNangoProviderKeys(capabilityId);
  if (providerKeys.length === 0) return; // pure-vault / no Nango tool — nothing to sync.

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

  // 3. Live Nango connections for the actor, filtered to this capability's
  //    providers. TYPED + paginated: a Nango HTTP error / rate-limit must NOT
  //    look like "zero connections", or the removal branch below would soft-
  //    delete every live pointer row. An unreliable list drives neither insert
  //    nor remove — we simply skip this pass and try again on the next call.
  const liveResult = await connector.listConnectionsResult(actorUserId);
  if (!liveResult.ok) {
    logger.warn(
      { capabilityId, actorUserId, reason: liveResult.reason },
      "Skipping Nango connection reconcile — could not list connections (not treating as empty)"
    );
    return;
  }
  const liveConnections = liveResult.connections;

  // The set of connectionIds Nango still reports for THIS capability's providers.
  // A pointer row whose account_hint is not in this set is an orphan — the
  // connection was revoked (in a disconnect door OR directly in the Nango
  // dashboard). This is the removal half that makes the reconciler symmetric;
  // without it, a revoked connection's `is_default` pointer lives forever and
  // dispatch keeps selecting a dead account.
  const liveHints = new Set(
    providerKeys.flatMap((key) =>
      liveConnections
        .filter((c) => c.provider === key)
        .map((c) => c.connectionId)
    )
  );

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

  // 4. Removal half: soft-delete pointer rows for connections Nango no longer
  //    reports. Only touches rows for THIS capability's providers whose hint is
  //    a known-but-now-gone connection — never rows we simply didn't mirror.
  const orphanHints = [...known].filter((h) => !liveHints.has(h));
  if (orphanHints.length > 0) {
    const removed = await db
      .update(secrets)
      .set({ deletedAt: new Date(), isDefault: false })
      .where(
        and(
          eq(secrets.capabilityId, capabilityId),
          eq(secrets.userId, actorUserId),
          inArray(secrets.accountHint, orphanHints),
          isNull(secrets.deletedAt)
        )
      )
      .returning({ id: secrets.id });

    if (removed.length > 0) {
      logger.info(
        { capabilityId, actorUserId, count: removed.length },
        "Reconciler removed pointer rows for revoked Nango connections"
      );
      // If we cleared the default, promote the oldest surviving live pointer so
      // dispatch still has a default account to pick.
      const survivor = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.capabilityId, capabilityId),
            eq(secrets.userId, actorUserId),
            eq(secrets.isDefault, false),
            isNull(secrets.deletedAt)
          )
        )
        .orderBy(secrets.createdAt)
        .limit(1);
      const anyDefault = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(
            eq(secrets.capabilityId, capabilityId),
            eq(secrets.userId, actorUserId),
            eq(secrets.isDefault, true),
            isNull(secrets.deletedAt)
          )
        )
        .limit(1);
      if (anyDefault.length === 0 && survivor[0]) {
        await db
          .update(secrets)
          .set({ isDefault: true })
          .where(eq(secrets.id, survivor[0].id));
      }
    }
  }
}

/**
 * Directly clean up the connection-registry footprint of a single revoked Nango
 * connection — called by the disconnect doors right after `revokeConnection`, so
 * a user-initiated disconnect takes effect immediately instead of waiting for
 * the lazy reconciler's next pass.
 *
 * Soft-deletes every pointer row whose `account_hint` is this connectionId (the
 * `is_default` binding included) across all capabilities. Does NOT delete the
 * pod-wide `nango://provider` tool row: it may still serve other connections or
 * users, and the catalog derives its connected/disconnected state live from
 * Nango anyway. Best-effort — never throws into the caller.
 */
export async function detachNangoConnectionRegistry(
  connectionId: string
): Promise<void> {
  try {
    const removed = await db
      .update(secrets)
      .set({ deletedAt: new Date(), isDefault: false })
      .where(
        and(eq(secrets.accountHint, connectionId), isNull(secrets.deletedAt))
      )
      .returning({ id: secrets.id });
    if (removed.length > 0) {
      logger.info(
        { connectionId, count: removed.length },
        "Disconnect cleaned up connection-registry pointer rows"
      );
    }

    // Mark any entities sourced from this connection as disconnected, so
    // "last synced" / source badges stop showing it as live.
    const linkRows = await db
      .update(entityExternalLinks)
      .set({ status: "disconnected", disconnectedAt: new Date() })
      .where(
        and(
          eq(entityExternalLinks.nangoConnectionId, connectionId),
          eq(entityExternalLinks.status, "active")
        )
      )
      .returning({ id: entityExternalLinks.id });
    if (linkRows.length > 0) {
      logger.info(
        { connectionId, count: linkRows.length },
        "Disconnect marked entity external links disconnected"
      );
    }
  } catch (err) {
    logger.warn(
      { err, connectionId },
      "detachNangoConnectionRegistry failed (best-effort)"
    );
  }
}
