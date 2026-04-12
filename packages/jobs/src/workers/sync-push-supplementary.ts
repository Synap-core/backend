/**
 * Sync Push Supplementary Worker
 *
 * Cron job (every 5 minutes) that pushes supplementary data to registered push peers.
 * Handles tables that don't emit events: messages, automations, intelligence_commands,
 * intelligence_services (metadata only — API keys excluded).
 *
 * For each enabled push peer:
 * 1. Read per-table cursors from sync_state.supplementaryCursors
 * 2. Query each table WHERE timestamp/updatedAt > cursor LIMIT 200
 * 3. POST batch to peer's /api/sync/receive-supplementary endpoint
 * 4. On success: advance per-table cursor
 * 5. Per-table failures don't block other tables
 */

import {
  db,
  syncPeers,
  syncState,
  messages,
  automations,
  automationRuns,
  intelligenceCommands,
  eq,
  and,
  or,
  gt,
} from "@synap/database";
import { intelligenceServices } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "sync-push-supplementary" });

/** Maximum rows per table per batch */
const BATCH_SIZE = 200;

/** HTTP timeout for sync requests (ms) */
const SYNC_TIMEOUT_MS = 30_000;

/** Source pod identifier (from env or fallback) */
const SOURCE_POD_ID =
  process.env.POD_ID || process.env.SYNAP_POD_ID || "unknown";

/** Tables to sync and their timestamp column for cursor-based pagination */
interface SupplementaryTableConfig {
  name: string;
  queryFn: (cursor: Date) => Promise<{
    rows: Record<string, unknown>[];
    lastTimestamp: string | null;
  }>;
}

/**
 * Build the list of supplementary tables to sync.
 * Each entry defines how to query rows newer than the cursor.
 */
function getTableConfigs(): SupplementaryTableConfig[] {
  return [
    {
      name: "messages",
      queryFn: async (cursor: Date) => {
        const rows = await db
          .select()
          .from(messages)
          .where(gt(messages.timestamp, cursor))
          .orderBy(messages.timestamp)
          .limit(BATCH_SIZE);

        if (rows.length === 0) return { rows: [], lastTimestamp: null };

        const last = rows[rows.length - 1];
        const lastTimestamp =
          last.timestamp instanceof Date
            ? last.timestamp.toISOString()
            : String(last.timestamp);

        return {
          rows: rows as unknown as Record<string, unknown>[],
          lastTimestamp,
        };
      },
    },
    {
      name: "automations",
      queryFn: async (cursor: Date) => {
        const rows = await db
          .select()
          .from(automations)
          .where(gt(automations.updatedAt, cursor))
          .orderBy(automations.updatedAt)
          .limit(BATCH_SIZE);

        if (rows.length === 0) return { rows: [], lastTimestamp: null };

        const last = rows[rows.length - 1];
        const lastTimestamp =
          last.updatedAt instanceof Date
            ? last.updatedAt.toISOString()
            : String(last.updatedAt);

        return {
          rows: rows as unknown as Record<string, unknown>[],
          lastTimestamp,
        };
      },
    },
    {
      name: "automation_runs",
      queryFn: async (cursor: Date) => {
        const rows = await db
          .select()
          .from(automationRuns)
          .where(gt(automationRuns.startedAt, cursor))
          .orderBy(automationRuns.startedAt)
          .limit(BATCH_SIZE);

        if (rows.length === 0) return { rows: [], lastTimestamp: null };

        const last = rows[rows.length - 1];
        const lastTimestamp =
          last.startedAt instanceof Date
            ? last.startedAt.toISOString()
            : String(last.startedAt);

        return {
          rows: rows as unknown as Record<string, unknown>[],
          lastTimestamp,
        };
      },
    },
    {
      name: "intelligence_services",
      queryFn: async (cursor: Date) => {
        // Sync metadata only — exclude apiKey (each pod has its own from CP)
        const rows = await db
          .select({
            id: intelligenceServices.id,
            serviceId: intelligenceServices.serviceId,
            name: intelligenceServices.name,
            description: intelligenceServices.description,
            version: intelligenceServices.version,
            webhookUrl: intelligenceServices.webhookUrl,
            mcpEndpoint: intelligenceServices.mcpEndpoint,
            // apiKey intentionally excluded — never synced between pods
            capabilities: intelligenceServices.capabilities,
            pricing: intelligenceServices.pricing,
            status: intelligenceServices.status,
            enabled: intelligenceServices.enabled,
            mcpApproved: intelligenceServices.mcpApproved,
            metadata: intelligenceServices.metadata,
            createdAt: intelligenceServices.createdAt,
            updatedAt: intelligenceServices.updatedAt,
            lastHealthCheck: intelligenceServices.lastHealthCheck,
            lastHealthStatus: intelligenceServices.lastHealthStatus,
          })
          .from(intelligenceServices)
          .where(gt(intelligenceServices.updatedAt, cursor))
          .orderBy(intelligenceServices.updatedAt)
          .limit(BATCH_SIZE);

        if (rows.length === 0) return { rows: [], lastTimestamp: null };

        const last = rows[rows.length - 1];
        const lastTimestamp =
          last.updatedAt instanceof Date
            ? last.updatedAt.toISOString()
            : String(last.updatedAt);

        return {
          rows: rows as unknown as Record<string, unknown>[],
          lastTimestamp,
        };
      },
    },
    {
      name: "intelligence_commands",
      queryFn: async (cursor: Date) => {
        const rows = await db
          .select()
          .from(intelligenceCommands)
          .where(gt(intelligenceCommands.updatedAt, cursor))
          .orderBy(intelligenceCommands.updatedAt)
          .limit(BATCH_SIZE);

        if (rows.length === 0) return { rows: [], lastTimestamp: null };

        const last = rows[rows.length - 1];
        const lastTimestamp =
          last.updatedAt instanceof Date
            ? last.updatedAt.toISOString()
            : String(last.updatedAt);

        return {
          rows: rows as unknown as Record<string, unknown>[],
          lastTimestamp,
        };
      },
    },
  ];
}

/**
 * Serialize row values for JSON transport.
 * Converts Date objects to ISO strings so the receiver can reconstruct them.
 */
function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    out[key] = val instanceof Date ? val.toISOString() : val;
  }
  return out;
}

/**
 * Push supplementary data for a single table to a single peer.
 */
async function pushTableToPeer(
  peer: { id: string; peerPodUrl: string; authToken: string | null },
  stateId: string,
  currentCursors: Record<string, string>,
  tableConfig: SupplementaryTableConfig
): Promise<void> {
  const cursorStr = currentCursors[tableConfig.name];
  const cursor = cursorStr ? new Date(cursorStr) : new Date(0);

  const { rows, lastTimestamp } = await tableConfig.queryFn(cursor);

  if (rows.length === 0 || !lastTimestamp) {
    return; // Nothing new for this table
  }

  // Serialize rows for transport
  const serializedRows = rows.map(serializeRow);

  const url = `${peer.peerPodUrl.replace(/\/+$/, "")}/api/sync/receive-supplementary`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Source-Pod-Id": SOURCE_POD_ID,
  };
  if (peer.authToken) {
    headers["Authorization"] = `Bearer ${peer.authToken}`;
  }

  const payload = {
    table: tableConfig.name,
    rows: serializedRows,
    cursor: lastTimestamp,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(
      `Peer responded ${response.status} for ${tableConfig.name}: ${errorText.slice(0, 200)}`
    );
  }

  // Success — advance this table's cursor
  const updatedCursors = {
    ...currentCursors,
    [tableConfig.name]: lastTimestamp,
  };
  await db
    .update(syncState)
    .set({
      supplementaryCursors: updatedCursors,
      updatedAt: new Date(),
    })
    .where(eq(syncState.id, stateId));

  logger.info(
    {
      peerId: peer.id,
      table: tableConfig.name,
      rowsSent: rows.length,
      cursor: lastTimestamp,
    },
    "Supplementary sync batch sent"
  );
}

/**
 * Push all supplementary tables to a single peer.
 */
async function pushToPeer(peer: {
  id: string;
  peerPodUrl: string;
  authToken: string | null;
}): Promise<void> {
  // Ensure sync_state row exists for this peer
  let state = await db.query.syncState.findFirst({
    where: eq(syncState.syncPeerId, peer.id),
  });

  if (!state) {
    const [inserted] = await db
      .insert(syncState)
      .values({ syncPeerId: peer.id })
      .returning();
    state = inserted;
  }

  const currentCursors = (state.supplementaryCursors ?? {}) as Record<
    string,
    string
  >;
  const tableConfigs = getTableConfigs();

  // Process each table independently — one failure shouldn't block others
  for (const tableConfig of tableConfigs) {
    try {
      await pushTableToPeer(peer, state.id, currentCursors, tableConfig);
      // Re-read cursors after each successful push so the next table sees the latest state
      const refreshed = await db.query.syncState.findFirst({
        where: eq(syncState.id, state.id),
        columns: { supplementaryCursors: true },
      });
      if (refreshed?.supplementaryCursors) {
        Object.assign(currentCursors, refreshed.supplementaryCursors);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        {
          peerId: peer.id,
          table: tableConfig.name,
          error: errorMessage,
        },
        "Supplementary sync failed for table"
      );
      // Continue with next table
    }
  }
}

/**
 * Main handler — called by pg-boss cron every 5 minutes.
 */
export async function handleSyncPushSupplementary(): Promise<void> {
  try {
    // Fetch all enabled push peers
    const peers = await db.query.syncPeers.findMany({
      where: and(
        or(
          eq(syncPeers.direction, "push"),
          eq(syncPeers.direction, "bidirectional")
        ),
        eq(syncPeers.enabled, true)
      ),
    });

    if (peers.length === 0) {
      return; // No push peers configured
    }

    logger.debug(
      { peerCount: peers.length },
      "Starting supplementary sync push cycle"
    );

    // Process each peer sequentially
    for (const peer of peers) {
      try {
        await pushToPeer(peer);
      } catch (err) {
        logger.error(
          { peerId: peer.id, err },
          "Unexpected error in supplementary sync push"
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("relation") && msg.includes("does not exist")) {
      logger.debug(
        "Supplementary sync push skipped — sync tables not yet migrated"
      );
    } else {
      logger.error({ err }, "Supplementary sync push worker top-level error");
    }
  }
}

export const SYNC_PUSH_SUPPLEMENTARY_QUEUE = "sync-push-supplementary";
