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

  // 5. Health half — PROACTIVE. Nango reports a per-connection `errors[]`; a
  //    non-empty array means the credential is dead (refresh failed) even though
  //    the connection still EXISTS, so the removal half above never touches it.
  //    Without this the registry reports a dead connection as "healthy" until a
  //    dispatch happens to pick it — which it may never do, because dispatch
  //    prefers the most-recent connection.
  //
  //    ESCALATE-ONLY: we mark `needs_reauth`, we never clear it here. Clearing is
  //    owned by the authoritative "a real call just succeeded" signal
  //    (`mirrorConnectionAuthOutcome("ok")` in external-dispatch), so a lagging
  //    broker view can't flip a genuinely-dead connection back to healthy.
  const erroredHints = liveConnections
    .filter((c) => c.hasError)
    .map((c) => c.connectionId);
  if (erroredHints.length > 0) {
    const marked = await db
      .update(secrets)
      .set({ connectionState: "needs_reauth", lastAuthErrorAt: new Date() })
      .where(
        and(
          eq(secrets.capabilityId, capabilityId),
          eq(secrets.userId, actorUserId),
          inArray(secrets.accountHint, erroredHints),
          isNull(secrets.deletedAt)
        )
      )
      .returning({ id: secrets.id });
    if (marked.length > 0) {
      logger.info(
        { capabilityId, actorUserId, count: marked.length },
        "Reconciler marked connections needs_reauth from Nango's own error state"
      );
    }
  }

  // 6. The default must point at a connection that WORKS. A default stuck on a
  //    dead account is worse than no default: an explicit-default run fails while
  //    a healthy account sits unused right beside it. Demote a dead default and
  //    promote the newest healthy pointer.
  const activeRows = await db
    .select({
      id: secrets.id,
      accountHint: secrets.accountHint,
      isDefault: secrets.isDefault,
      connectionState: secrets.connectionState,
      createdAt: secrets.createdAt,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.capabilityId, capabilityId),
        eq(secrets.userId, actorUserId),
        isNull(secrets.deletedAt)
      )
    );
  const move = chooseHealthyDefault(activeRows, erroredHints);
  if (move) {
    // Demote FIRST: `idx_secrets_capability_default` allows only one default per
    // capability, so promoting before demoting would violate it.
    await db
      .update(secrets)
      .set({ isDefault: false })
      .where(eq(secrets.id, move.demoteId));
    await db
      .update(secrets)
      .set({ isDefault: true })
      .where(eq(secrets.id, move.promoteId));
    logger.info(
      { capabilityId, actorUserId, from: move.demoteId, to: move.promoteId },
      "Reconciler moved the default off a dead connection onto a healthy one"
    );
  }
}

/** A registry pointer row, reduced to what the default-choice decision reads. */
export interface DefaultCandidateRow {
  id: string;
  accountHint: string | null;
  isDefault: boolean;
  connectionState: string | null;
  createdAt: Date;
}

/**
 * Decide whether the default must move off a dead connection — the pure core of
 * step 6 (exported for test).
 *
 * A connection is dead when the health mirror says `needs_reauth` OR the broker
 * currently reports an error for it. Returns the demote/promote pair, or null
 * when the default is fine (or when there is no healthy alternative — a lone
 * dead default is LEFT in place, because dropping it would leave the capability
 * with no default at all and tell the user nothing).
 *
 * Picks the NEWEST healthy pointer, matching what the dispatcher picks when no
 * account is pinned, so the stored default and the implicit pick agree.
 */
export function chooseHealthyDefault(
  rows: DefaultCandidateRow[],
  erroredHints: string[]
): { demoteId: string; promoteId: string } | null {
  const errored = new Set(erroredHints);
  const isDead = (r: DefaultCandidateRow): boolean =>
    r.connectionState === "needs_reauth" ||
    (!!r.accountHint && errored.has(r.accountHint));

  const current = rows.find((r) => r.isDefault);
  if (!current || !isDead(current)) return null;

  const healthy = rows
    .filter((r) => !r.isDefault && !isDead(r))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return healthy ? { demoteId: current.id, promoteId: healthy.id } : null;
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
