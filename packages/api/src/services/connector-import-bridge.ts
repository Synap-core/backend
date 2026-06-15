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
 * KNOWN GAP (flagged for the import-orchestrator owner): the orchestrator's
 * `ImportRevealSource` union is `"obsidian" | "markdown" | "csv" | "bookmark"`
 * and does NOT yet include `"connector_sync"`. A connector record is flat
 * structured data (1 record → 1 entity), which is exactly the CSV adapter's
 * shape, so we map to `source: "csv"` (the closest accepted value) rather than
 * editing the orchestrator. When the owner adds a first-class `connector_sync`
 * source + adapter, switch the `IMPORT_SOURCE` constant below.
 */

import { createLogger } from "@synap-core/core";
import { NangoConnector } from "../connectors/NangoConnector.js";
import { ImportOrchestrator } from "./import-orchestrator.js";

const logger = createLogger({ module: "connector-import-bridge" });

/**
 * Closest accepted `ImportRevealSource`. Connector records are flat structured
 * rows → 1 entity each, matching the CSV adapter's shallow path. See KNOWN GAP
 * above — replace with `"connector_sync"` once the orchestrator accepts it.
 */
const IMPORT_SOURCE = "csv" as const;

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
  // readable synthetic path per record.
  const provider = connectionId.split(":")[2] || model || "connector";

  const items = records.map((r) => ({
    path: `${provider}/${r.externalId}`,
    content: JSON.stringify(r.data),
  }));

  const orchestrator = new ImportOrchestrator(ctx);
  const result = await orchestrator.analyze({
    source: IMPORT_SOURCE,
    items,
  });

  logger.info(
    {
      connectionId,
      model,
      provider,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      recordCount: records.length,
      proposalId: result.proposalId,
    },
    "connector sync → import proposal created"
  );

  return {
    proposalId: result.proposalId,
    recordCount: records.length,
    itemCount: items.length,
    source: IMPORT_SOURCE,
  };
}
