/**
 * Import Corpus Worker (large background import)
 *
 * Runs a large prose/CSV corpus import as a background pg-boss job instead of
 * synchronously inside the tRPC request. The actual structuring work lives in
 * `ImportOrchestrator.analyzeLarge` (in @synap/api), which produces ONE governed
 * `import.graph` PROPOSAL — never a direct write.
 *
 * Inversion of Control: the one-way `api → jobs` dependency means jobs MUST NOT
 * import @synap/api. So this module owns the QUEUE + a handler SLOT; the api
 * layer fills the slot at boot (see apps/api/src/index.ts → registerAllWorkers).
 * The worker just invokes whatever handler was registered.
 *
 * Queue: "import-corpus"
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "import-corpus-worker" });

export const IMPORT_CORPUS_QUEUE = "import-corpus";

export interface ImportCorpusPayload {
  userId: string;
  workspaceId: string;
  source: string;
  items: Array<{ path: string; content: string }>;
}

type Handler = (p: ImportCorpusPayload) => Promise<void>;

/**
 * Module-level handler slot. Filled by the api layer at boot via
 * `registerImportCorpusHandler` — jobs never imports the orchestrator itself.
 */
let handler: Handler | null = null;

export function registerImportCorpusHandler(fn: Handler): void {
  handler = fn;
}

export async function handleImportCorpus(
  job: PgBoss.Job<ImportCorpusPayload>
): Promise<void> {
  const startedAt = Date.now();
  const { workspaceId, userId, source, items } = job.data;

  logger.info(
    { workspaceId, userId, source, total: items?.length ?? 0 },
    "Starting corpus import"
  );

  if (!handler) {
    throw new Error("import-corpus handler not registered");
  }

  try {
    await handler(job.data);
    logger.info(
      {
        source,
        status: "completed",
        durationMs: Date.now() - startedAt,
        workspaceId,
        total: items?.length ?? 0,
      },
      "Corpus import telemetry"
    );
  } catch (err) {
    logger.error({ err, workspaceId, userId, source }, "Corpus import failed");
    throw err;
  }
}
