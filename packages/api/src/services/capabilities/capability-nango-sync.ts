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
  isNotNull,
  inArray,
  encryptServerSide,
  ensureConnectionAutoRule,
  ensureConnectionReviewRule,
  retireConnectionRules,
} from "@synap/database";
import {
  secrets,
  entityExternalLinks,
  links,
  tools,
} from "@synap/database/schema";
import {
  clearConnectionSyncState,
  findApprovedConnectionImport,
  resolveSyncTool,
} from "../event-sync/sync-state-store.js";
import { createLogger } from "@synap-core/core";

import { resolveBroker } from "../../connectors/index.js";
import type { ConnectionBroker } from "../../connectors/ConnectionBroker.js";
import { BrokerConnectionNotFoundError } from "../../connectors/CpBrokerConnector.js";
import type { SyncConnectorConnection } from "../../connectors/SyncConnector.js";
import { enqueueConnectionSync } from "../event-sync/connection-sync.js";
import { resolveCapabilityNangoProviderKeys } from "./capability-provider-resolution.js";

const logger = createLogger({ module: "capability-nango-sync" });

/**
 * Mirror the actor's live Nango connections for `capabilityId` into `secrets`
 * pointer rows. Returns silently on any failure (best-effort backfill/refresh).
 */
export async function syncNangoConnectionsToRegistry(
  capabilityId: string,
  actorUserId: string,
  /**
   * The actor's live connections when the caller JUST read them from the broker
   * (one broker read per request, not one per capability). Must be the actor's
   * COMPLETE live list: the removal half treats absence as revoked.
   */
  live?: SyncConnectorConnection[]
): Promise<void> {
  // 1. The capability's Nango providers — resolved the SAME way the catalog card
  //    does (member_of tool links first, template-def fallback). Sharing this with
  //    the card + list is what stops the reconciler early-returning while the card
  //    can still see the tool via its template def.
  const providerKeys = await resolveCapabilityNangoProviderKeys(capabilityId);
  if (providerKeys.length === 0) return; // pure-vault / no Nango tool — nothing to sync.

  let liveList = live;
  if (!liveList) {
    const resolved = await resolveBroker("nango");
    if (!resolved.ok) {
      // No broker, or a broker fault: leave the registry untouched either way —
      // but a fault is logged, never read as "this user has no connections".
      if (resolved.reason !== "not-configured") {
        logger.warn(
          { capabilityId, actorUserId, reason: resolved.reason },
          "Skipping connection reconcile — the connection broker is unavailable"
        );
      }
      return;
    }
    const connector = resolved.broker;
    const liveResult = await connector.listConnectionsResult(actorUserId);
    if (!liveResult.ok) {
      logger.warn(
        { capabilityId, actorUserId, reason: liveResult.reason },
        "Skipping Nango connection reconcile — could not list connections (not treating as empty)"
      );
      return;
    }
    liveList = liveResult.connections;
  }

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

  // 3. Live Nango connections for the actor (read above, or supplied), filtered
  //    to this capability's providers. A broker HTTP error / truncated page
  //    never reaches here — it returned above rather than look like "zero
  //    connections", which would make the removal branch below soft-delete
  //    every live pointer row.
  const liveConnections = liveList;

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
      const [created] = await db
        .insert(secrets)
        .values({
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
        })
        .returning({ id: secrets.id });

      // A connection first observed ⇒ its first sync. The registry row id IS
      // the connection's identity for the sync door. An enqueue failure must not
      // undo the mirror, but it is logged — the connection would otherwise sit
      // unsynced with nothing saying why.
      if (created) {
        await enqueueConnectionSync({
          provider: providerConfigKey,
          connectionId: created.id,
          workspaceId: null,
          reason: "connect",
        }).catch((err: unknown) =>
          logger.warn(
            { err, capabilityId, connectionId: created.id },
            "Could not enqueue the first sync for a newly observed connection"
          )
        );
      }
    }
  }

  // 4. Removal half: soft-delete pointer rows for connections Nango no longer
  //    reports. Only touches rows for THIS capability's providers whose hint is
  //    a known-but-now-gone connection — never rows we simply didn't mirror.
  const orphanHints = [...known].filter((h) => !liveHints.has(h));
  if (orphanHints.length > 0) {
    const orphaned = and(
      eq(secrets.capabilityId, capabilityId),
      eq(secrets.userId, actorUserId),
      inArray(secrets.accountHint, orphanHints),
      isNull(secrets.deletedAt)
    );
    const orphans = await db
      .select({ id: secrets.id })
      .from(secrets)
      .where(orphaned);
    await retireConnectionRows(orphans.map((r) => r.id));
    const removed = await db
      .update(secrets)
      .set({ deletedAt: new Date(), isDefault: false })
      .where(orphaned)
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

export type ReconcileLiveOutcome =
  /** `capabilities` = how many capabilities were reconciled (0 = no provider tool yet). */
  | { ok: true; capabilities: number }
  | { ok: false; reason: string; error: string };

/**
 * Mirror a user's live connections into the registry for every capability that
 * carries their provider's `nango://` tool. Inserting a pointer row enqueues the
 * connection's first sync (see `syncNangoConnectionsToRegistry`); a connection
 * already mirrored is skipped, so repeated calls enqueue nothing more.
 *
 * Two callers:
 *   - a client door that JUST read the list passes it as `live` (one broker read
 *     per request). It must be the user's COMPLETE live list.
 *   - a server-side caller with no client context (e.g. a sync trigger that
 *     found no registry row) omits `live`; the list is read here through the
 *     broker. A broker fault or failed list is `ok:false` — nothing is
 *     reconciled off an unread list.
 *
 * It does not materialize a missing provider tool (that needs a caller context
 * for the governed template apply): with no tool yet it reconciles nothing and
 * reports `capabilities: 0`.
 */
export async function reconcileLiveConnections(
  userId: string,
  live?: SyncConnectorConnection[]
): Promise<ReconcileLiveOutcome> {
  let list = live;
  if (!list) {
    const resolved = await resolveBroker("nango");
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason, error: resolved.error };
    }
    const listed = await resolved.broker.listConnectionsResult(userId);
    if (!listed.ok) {
      return { ok: false, reason: listed.reason, error: listed.error };
    }
    list = listed.connections;
  }
  const refs = [...new Set(list.map((c) => `nango://${c.provider}`))];
  if (refs.length === 0) return { ok: true, capabilities: 0 };
  const toolRows = await db
    .select({ id: tools.id })
    .from(tools)
    .where(inArray(tools.credentialRef, refs));
  if (toolRows.length === 0) return { ok: true, capabilities: 0 };
  const edges = await db
    .select({ capabilityId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "tool"),
        inArray(
          links.fromId,
          toolRows.map((t) => t.id)
        ),
        eq(links.linkType, "member_of"),
        eq(links.toType, "capability")
      )
    );
  const capabilityIds = new Set(edges.map((e) => e.capabilityId));
  for (const capabilityId of capabilityIds) {
    await syncNangoConnectionsToRegistry(capabilityId, userId, list);
  }
  return { ok: true, capabilities: capabilityIds.size };
}

/**
 * The provider a registry row syncs as, derived from the row itself: the one of
 * its capability's Nango providers whose sync tool this connection resolves to
 * (the same join the sync door runs). With `wanted`, only that provider is
 * considered. `null` = the row has no sync tool for any (or that) provider.
 */
async function resolveRowSyncProvider(
  capabilityId: string,
  connectionId: string,
  wanted?: string
): Promise<{
  provider: string;
  tool: NonNullable<Awaited<ReturnType<typeof resolveSyncTool>>>;
} | null> {
  const keys = await resolveCapabilityNangoProviderKeys(capabilityId);
  for (const provider of wanted ? keys.filter((k) => k === wanted) : keys) {
    const tool = await resolveSyncTool({ provider, connectionId });
    if (tool) return { provider, tool };
  }
  return null;
}

export type KeepSyncingOutcome =
  | { ok: true; enabled: boolean; ruleId?: string }
  | { ok: false; reason: "not_found" | "no_approved_import"; error: string };

/**
 * The "keep syncing automatically" toggle for ONE of the caller's connections.
 *
 * On = the connection's `auto` governance rule (steady syncs apply without a
 * proposal); off = that rule revoked (the next sync proposes). The rule is
 * scoped exactly where the sync door evaluates it — the workspace of the
 * provider tool that carries this connection's sync config — so the toggle and
 * the runner can never disagree about which rule applies.
 *
 * A rule is earned consent with lineage: it records the approved first-import
 * proposal it grew from. Turning it on before any import of this connection was
 * approved has no such proposal, so it is refused rather than minted without
 * lineage. Another user's row, a deleted row or a non-registry row is
 * `not_found` — ownership is checked in code.
 */
export async function setConnectionKeepSyncing(input: {
  userId: string;
  connectionId: string;
  enabled: boolean;
}): Promise<KeepSyncingOutcome> {
  const notFound = {
    ok: false as const,
    reason: "not_found" as const,
    error: "Connection not found",
  };
  const [row] = await db
    .select({
      id: secrets.id,
      userId: secrets.userId,
      capabilityId: secrets.capabilityId,
      deletedAt: secrets.deletedAt,
    })
    .from(secrets)
    .where(eq(secrets.id, input.connectionId))
    .limit(1);
  if (
    !row ||
    row.userId !== input.userId ||
    !row.capabilityId ||
    row.deletedAt
  ) {
    return notFound;
  }
  const synced = await resolveRowSyncProvider(row.capabilityId, row.id);
  if (!synced) return notFound;

  const scope = {
    db,
    userId: input.userId,
    workspaceId: synced.tool.workspaceId ?? null,
    connectionId: row.id,
  };

  const approved = await findApprovedConnectionImport(row.id);
  if (!approved) {
    return {
      ok: false,
      reason: "no_approved_import",
      error:
        "Automatic syncing can be changed once this connection's first import has been approved.",
    };
  }

  if (!input.enabled) {
    // An explicit review rule naming the approved import, not just a revoke:
    // the approval hook may not have minted its auto rule yet, and it must not
    // mint one for an import the owner already turned off.
    await ensureConnectionReviewRule({
      ...scope,
      sourceProposalId: approved.id,
    });
    return { ok: true, enabled: false };
  }

  const { ruleId } = await ensureConnectionAutoRule({
    ...scope,
    sourceProposalId: approved.id,
  });
  return { ok: true, enabled: true, ruleId };
}

export type ManualSyncOutcome =
  /**
   * `queued` = targets a new run was queued for; `debounced` = targets whose
   * provider + connection already had a run inside the debounce window, so
   * nothing new was queued for them.
   */
  | { ok: true; queued: number; debounced: number }
  | { ok: false; reason: "not_found"; error: string };

/**
 * "Sync now" for the caller's OWN connections — the door behind
 * `connectors.syncNow` (the user's "Try again").
 *
 * With `connectionId` (a registry row id, the id sync-status rows carry): the row
 * must be the caller's, a connection-registry row (capability set) and not
 * deleted; its provider is the one its sync tool resolves under (never merely the
 * capability's first provider key). With only `provider`: every one of the
 * caller's live registry rows that syncs as that provider. Anything else —
 * another user's row, a deleted row, nothing to sync — is `not_found`, the same
 * answer either way so a caller cannot probe another user's ids. The owner check
 * runs in code, not only in SQL.
 */
export async function enqueueManualConnectionSync(input: {
  userId: string;
  connectionId?: string;
  provider?: string;
}): Promise<ManualSyncOutcome> {
  const columns = {
    id: secrets.id,
    userId: secrets.userId,
    capabilityId: secrets.capabilityId,
    deletedAt: secrets.deletedAt,
  };
  const rows = input.connectionId
    ? await db
        .select(columns)
        .from(secrets)
        .where(eq(secrets.id, input.connectionId))
    : await db
        .select(columns)
        .from(secrets)
        .where(
          and(eq(secrets.userId, input.userId), isNull(secrets.deletedAt))
        );

  const owned = rows.filter(
    (r) => r.userId === input.userId && !!r.capabilityId && !r.deletedAt
  );

  const targets: Array<{ connectionId: string; provider: string }> = [];
  for (const row of owned) {
    const synced = await resolveRowSyncProvider(
      row.capabilityId!,
      row.id,
      input.provider
    );
    if (synced)
      targets.push({ connectionId: row.id, provider: synced.provider });
  }

  if (targets.length === 0) {
    return {
      ok: false,
      reason: "not_found",
      error: input.connectionId
        ? "Connection not found"
        : `You have no "${input.provider}" connection to sync`,
    };
  }
  // A queue fault throws, and a debounced target is not counted as queued —
  // "sync requested" is never claimed when it was not.
  let queued = 0;
  let debounced = 0;
  for (const t of targets) {
    const result = await enqueueConnectionSync({
      provider: t.provider,
      connectionId: t.connectionId,
      workspaceId: null,
      reason: "manual",
    });
    if (result.queued) queued++;
    else debounced++;
  }
  return { ok: true, queued, debounced };
}

export type DisconnectOwnedOutcome =
  | { ok: true; provider: string }
  | { ok: false; reason: "not_found" | "list_failed"; error: string };

/**
 * The disconnect door shared by tRPC and Hub REST: revoke ONE of the acting
 * user's own connections, then clean up its registry footprint.
 *
 * Ownership is proven from the user's live broker list before anything happens.
 * Without it a caller could name another user's connection id: the revoke is
 * refused (or is a no-op) but `detachNangoConnectionRegistry` — which matches by
 * connection id across ALL users — would still soft-delete that user's pointer
 * rows. A failed list proves nothing, so it refuses too.
 */
export async function disconnectOwnedConnection(input: {
  broker: ConnectionBroker;
  userId: string;
  connectionId: string;
}): Promise<DisconnectOwnedOutcome> {
  const listed = await input.broker.listConnectionsResult(input.userId);
  if (!listed.ok) {
    return {
      ok: false,
      reason: "list_failed",
      error: `Could not verify the connection (${listed.reason}): ${listed.error}`,
    };
  }
  const own = listed.connections.find(
    (c) => c.connectionId === input.connectionId
  );
  if (!own) {
    return { ok: false, reason: "not_found", error: "Connection not found" };
  }
  try {
    await input.broker.revokeConnection(
      own.connectionId,
      own.provider,
      input.userId
    );
  } catch (err) {
    // Ownership was proven from the live list just above; a broker "not found"
    // now means it was revoked in between — the desired end state.
    if (!(err instanceof BrokerConnectionNotFoundError)) throw err;
  }
  await detachNangoConnectionRegistry(own.connectionId);
  return { ok: true, provider: own.provider };
}

/**
 * What a gone connection leaves behind besides its registry rows: its
 * governance rules (no longer able to govern anything) and its run state on the
 * provider tools. Cleared BEFORE the rows are soft-deleted, so a failure leaves
 * the rows live and a retry finds them again.
 */
async function retireConnectionRows(rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return;
  await retireConnectionRules({ connectionIds: rowIds });
  await clearConnectionSyncState(rowIds);
}

/**
 * Directly clean up the footprint of a single revoked broker connection —
 * called by the disconnect doors right after `revokeConnection`, so a
 * user-initiated disconnect takes effect immediately instead of waiting for the
 * lazy reconciler's next pass.
 *
 * For every pointer row whose `account_hint` is this connectionId (the
 * `is_default` binding included) across all capabilities: retires its rules
 * and run state, marks its entity links disconnected, then soft-deletes the row.
 * Does NOT delete the pod-wide `nango://provider` tool row: it may still serve
 * other connections or users. A failure throws — the caller must not report a
 * clean disconnect that did not happen.
 */
export async function detachNangoConnectionRegistry(
  connectionId: string
): Promise<void> {
  const rows = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(eq(secrets.accountHint, connectionId), isNull(secrets.deletedAt))
    );
  await detachRegistryRows(
    rows.map((r) => r.id),
    [connectionId]
  );
}

/**
 * The detach itself, for rows the caller has ALREADY scoped: retire their rules
 * and run state, mark their entity links disconnected, then soft-delete them.
 *
 * The sync door stamps links with the registry ROW id; links written before it
 * carry the broker's connection id, so a caller that proved which broker
 * connection this is passes it in `brokerConnectionIds`. A caller that only
 * knows row ids passes none — an account hint is free text for vault
 * connections and may name another user's link.
 */
async function detachRegistryRows(
  rowIds: string[],
  brokerConnectionIds: string[]
): Promise<void> {
  await retireConnectionRows(rowIds);

  const linkKeys = [...brokerConnectionIds, ...rowIds];
  if (linkKeys.length > 0) {
    const linkRows = await db
      .update(entityExternalLinks)
      .set({ status: "disconnected", disconnectedAt: new Date() })
      .where(
        and(
          inArray(entityExternalLinks.nangoConnectionId, linkKeys),
          eq(entityExternalLinks.status, "active")
        )
      )
      .returning({ id: entityExternalLinks.id });
    if (linkRows.length > 0) {
      logger.info(
        { count: linkRows.length },
        "Disconnect marked entity external links disconnected"
      );
    }
  }

  if (rowIds.length > 0) {
    await db
      .update(secrets)
      .set({ deletedAt: new Date(), isDefault: false })
      .where(inArray(secrets.id, rowIds));
    logger.info(
      { count: rowIds.length },
      "Disconnect cleaned up connection-registry pointer rows"
    );
  }
}

export interface UserConnectionsRemoved {
  /** Connections revoked at the broker. */
  revoked: number;
  /** Registry connections detached whose broker connection was already gone. */
  detached: number;
}

/**
 * Remove every connection a user holds — run before a user is deleted, so a
 * deleted person's accounts stop syncing and their broker grants are revoked.
 *
 * Each connection still in the user's broker list goes through
 * `disconnectOwnedConnection` (revoke, then detach). Registry rows whose
 * connection the broker no longer reports are then detached. Any failure
 * throws — an unreadable broker, a failed revoke, a failed cleanup — so the
 * caller keeps the user and the removal can be retried; rows are only
 * soft-deleted once their cleanup succeeded, so a retry resumes where it
 * stopped. A pod with no broker configured has nothing to revoke and only
 * detaches.
 */
export async function disconnectAllUserConnections(
  userId: string
): Promise<UserConnectionsRemoved> {
  let revoked = 0;
  const resolved = await resolveBroker("nango");
  if (resolved.ok) {
    const listed = await resolved.broker.listConnectionsResult(userId);
    if (!listed.ok) {
      throw new Error(
        `Could not list the user's connections (${listed.reason}): ${listed.error}`
      );
    }
    for (const c of listed.connections) {
      const outcome = await disconnectOwnedConnection({
        broker: resolved.broker,
        userId,
        connectionId: c.connectionId,
      });
      if (outcome.ok) revoked++;
      // not_found = revoked in between; its rows are detached below.
      else if (outcome.reason !== "not_found") throw new Error(outcome.error);
    }
  } else if (resolved.reason !== "not-configured") {
    throw new Error(
      `The connection broker is unavailable (${resolved.reason}): ${resolved.error}`
    );
  }

  // Detached by ROW id under this user's floor, never by account hint: a hint
  // is free text for vault connections and can match another user's rows.
  const leftover = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.userId, userId),
        isNotNull(secrets.accountHint),
        isNull(secrets.deletedAt)
      )
    );
  await detachRegistryRows(
    leftover.map((r) => r.id),
    []
  );
  return { revoked, detached: leftover.length };
}
