/**
 * Connector → Import bridge (P4 of Universal Intake, Nango-only).
 *
 * THE GAP this closes: a connected Nango source previously had no path into the
 * import ENGINE — `NangoConnector.fetchRecords()` had zero callers, so synced
 * records never became reviewable entity proposals. This producer is that
 * missing caller: it pulls records on demand and routes them through the
 * canonical `ImportOrchestrator.analyze()` so each sync lands as ONE governed
 * `import.graph` proposal (review-gated, never a direct write).
 *
 * NAMED DEFAULT: on-demand only ("sync this connection now → proposal"). No cron
 * scheduling here — that is a later phase.
 *
 * Each synced record maps 1:1 to ONE import item via the first-class
 * `connector_sync` source + adapter (a flat structured record → one
 * entity-candidate). This replaced the earlier CSV-aggregation stopgap (N
 * records → one CSV blob → re-parse) now that the orchestrator accepts the
 * `connector_sync` source directly.
 */

import { createLogger } from "@synap-core/core";
import { NangoConnector } from "../connectors/NangoConnector.js";
import { ImportOrchestrator } from "./import-orchestrator.js";

const logger = createLogger({ module: "connector-import-bridge" });

/**
 * First-class connector source. The `connector_sync` adapter maps one record →
 * one entity-candidate (title + metadata + readable key:value body) on the
 * orchestrator's shallow path — correct for flat structured records.
 */
const IMPORT_SOURCE = "connector_sync" as const;

export type SyncConnectionToImportInput = {
  ctx: {
    workspaceId: string;
    userId: string;
    trpcCtx: Record<string, unknown>;
  };
  /** Nango connection id, format `{userId}:{podId}:{provider}`. */
  connectionId: string;
  /** Nango sync model to pull records for (e.g. "Contact", "Issue"). */
  model: string;
  /** Only pull records modified after this instant (incremental sync). */
  since?: Date;
  /** Optional pre-built connector (tests / DI). Defaults to env-config Nango. */
  connector?: NangoConnector;
};

export type SyncConnectionToImportResult = {
  proposalId: string | null;
  /** Number of records fetched from the connector. */
  recordCount: number;
  /** Number of items the orchestrator surfaced into the proposal. */
  itemCount: number;
  source: typeof IMPORT_SOURCE;
};

/**
 * Pull records for one connection+model and turn them into a single governed
 * import proposal. Returns the proposal id and counts. When the connection has
 * no records, returns `{ proposalId: null, recordCount: 0 }` without creating an
 * empty proposal.
 */
export async function syncConnectionToImport(
  input: SyncConnectionToImportInput
): Promise<SyncConnectionToImportResult> {
  const { ctx, connectionId, model, since } = input;
  const connector = input.connector ?? new NangoConnector();

  if (!connector.isConfigured()) {
    throw new Error(
      "Nango is not configured on this pod — cannot sync connection to import."
    );
  }

  const records = await connector.fetchRecords(connectionId, model, since);
  if (records.length === 0) {
    logger.info(
      { connectionId, model, userId: ctx.userId, workspaceId: ctx.workspaceId },
      "connector sync: no records to import"
    );
    return {
      proposalId: null,
      recordCount: 0,
      itemCount: 0,
      source: IMPORT_SOURCE,
    };
  }

  // Provider = 3rd segment of `{userId}:{podId}:{provider}`; fall back to the
  // model when the id isn't in that shape. Used only to build a stable, human
  // readable synthetic per-record path.
  const provider = connectionId.split(":")[2] || model || "connector";

  // Map each record 1:1 to ONE import item: `content` is the record serialized
  // as JSON (the connector_sync adapter parses it back to build the entity), and
  // `path` is a synthetic per-record key. This is the first-class connector path
  // (replaced the CSV-aggregation stopgap).
  const items = records.map((r, i) => ({
    path: `${provider}/${model}/${i}.json`,
    content: JSON.stringify(r.data),
  }));

  const orchestrator = new ImportOrchestrator(ctx);
  const result = await orchestrator.analyze({
    source: IMPORT_SOURCE,
    items,
  });

  // Real item count comes from the orchestrator AFTER the adapter ran (one per
  // record). `stats` is typed `Record<string, unknown>`, so narrow before use;
  // the connector_sync adapter produces one item per record, so `records.length`
  // is the right fallback.
  const statsItemCount = (result.stats as { itemCount?: unknown } | undefined)
    ?.itemCount;
  const itemCount =
    typeof statsItemCount === "number" ? statsItemCount : records.length;

  logger.info(
    {
      connectionId,
      model,
      provider,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      recordCount: records.length,
      itemCount,
      proposalId: result.proposalId,
    },
    "connector sync → import proposal created"
  );

  return {
    proposalId: result.proposalId,
    recordCount: records.length,
    itemCount,
    source: IMPORT_SOURCE,
  };
}
