/**
 * Context-Card Refresh Cron Worker
 *
 * Once daily, walks every Discord TEAM thread that is bound to a client entity
 * and enqueues one `refresh_context_card` channel-egress per (entity, thread).
 * The Discord bridge later pulls each pending egress row and re-fetches +
 * re-renders that channel's pinned context card (the bridge owns the dispatch
 * case; this worker only DEFINES + ENQUEUES the intent).
 *
 * Firewall — TEAM channels only (branchPurpose='team'). Client-comms channels
 * still HAVE a context card, but the bridge never pins one there, so we never
 * enqueue a refresh for them.
 *
 * Selection: channels WHERE externalSource='discord' AND branchPurpose='team'
 * AND contextObjectId IS NOT NULL. Deduped per (entityId, externalId) so a
 * malformed duplicate binding can never double-post.
 */

import { db, eq, and, isNotNull, enqueueChannelEgress } from "@synap/database";
import { channels } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "context-card-refresh" });

export const CONTEXT_CARD_REFRESH_QUEUE = "context-card-refresh";
/** Daily at 06:10 UTC — before the CRM digest (08:55), after nightly hygiene. */
export const CONTEXT_CARD_REFRESH_CRON = "10 6 * * *";

/** The channel columns the refresh selection needs. */
export interface TeamThreadRow {
  entityId: string | null;
  externalId: string | null;
  workspaceId: string | null;
}

/** One enqueue intent: refresh the pinned card on a Discord team thread. */
export interface RefreshTarget {
  entityId: string;
  externalId: string;
  workspaceId: string | null;
}

/**
 * Pure dedup: collapse team-thread rows to one refresh per (entityId,
 * externalId). Rows missing an entity binding or an external id are dropped
 * (nothing to refresh / nowhere to deliver).
 */
export function dedupeRefreshTargets(rows: TeamThreadRow[]): RefreshTarget[] {
  const seen = new Set<string>();
  const out: RefreshTarget[] = [];
  for (const row of rows) {
    if (!row.entityId || !row.externalId) continue;
    const key = `${row.entityId}::${row.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      entityId: row.entityId,
      externalId: row.externalId,
      workspaceId: row.workspaceId,
    });
  }
  return out;
}

export async function handleContextCardRefresh(): Promise<void> {
  const rows = await db
    .select({
      entityId: channels.contextObjectId,
      externalId: channels.externalId,
      workspaceId: channels.workspaceId,
    })
    .from(channels)
    .where(
      and(
        eq(channels.externalSource, "discord"),
        eq(channels.branchPurpose, "team"),
        isNotNull(channels.contextObjectId)
      )
    );

  const targets = dedupeRefreshTargets(rows);
  logger.info(
    { candidates: rows.length, targets: targets.length },
    "context-card-refresh: enqueuing refresh_context_card egress for team threads"
  );

  for (const target of targets) {
    try {
      await enqueueChannelEgress({
        externalSource: "discord",
        externalId: target.externalId,
        kind: "refresh_context_card",
        payload: { channelId: target.externalId },
        workspaceId: target.workspaceId,
      });
    } catch (err) {
      logger.error(
        { err, externalId: target.externalId, entityId: target.entityId },
        "context-card-refresh: enqueue failed — skipping this thread"
      );
    }
  }
}
