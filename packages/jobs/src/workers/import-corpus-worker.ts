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

/**
 * A single quality finding carried out of the run (severity + message), so the
 * poller can say WHY files were dropped instead of only that they were.
 */
export interface ImportCorpusFinding {
  id?: string;
  severity: string;
  message: string;
}

/**
 * What the corpus run reports back — a PROJECTION of
 * `ImportOrchestrator.analyzeLarge`'s return value, small enough to store as the
 * pg-boss job `output` (the full return carries every operation of a 300-file
 * graph; that belongs on the proposal, not in the job row).
 *
 * Owned HERE and not imported from @synap/api for the same reason
 * `ImportCorpusPayload` is: the api → jobs dependency is one-way. This type is
 * the queue's OUTPUT contract exactly as `ImportCorpusPayload` is its INPUT
 * contract; the api layer fills it at boot from the orchestrator's own
 * `quality.counts` — no numbers are recomputed here.
 *
 * WHY it exists: the handler's result used to be discarded, so
 * `GET /import/corpus-job/:jobId` could only report `state: "completed"`. A run
 * that structured 1 of 3 files and recorded `filesFailed: 2` on the proposal
 * reported success to the CLI. (Files fail mostly on the 8000-char `text` cap
 * enforced at both structure doors — routers/capture.ts and the IS
 * routes/structure.ts. Making that VISIBLE is this contract's whole job.)
 */
export interface ImportCorpusResult {
  /** The governed import.graph proposal this run produced, if any. */
  proposalId: string | null;
  workspaceId: string | null;
  /** From `quality.counts` — undefined when the report did not compute them. */
  filesProcessed?: number;
  filesFailed?: number;
  /** 0–100 composite from the quality report. */
  qualityScore?: number;
  /** warn/blocker findings only, capped — they name the cause. */
  findings?: ImportCorpusFinding[];
}

type Handler = (p: ImportCorpusPayload) => Promise<ImportCorpusResult | void>;

/**
 * Module-level handler slot. Filled by the api layer at boot via
 * `registerImportCorpusHandler` — jobs never imports the orchestrator itself.
 */
let handler: Handler | null = null;

export function registerImportCorpusHandler(fn: Handler): void {
  handler = fn;
}

/**
 * Runs the registered handler and RETURNS its result.
 *
 * The return value matters: pg-boss stores whatever the work callback resolves
 * to as the job's `output` column (manager.js → `complete(name, ids, result)`),
 * which is what `GET /import/corpus-job/:jobId` reads back. Discarding it — as
 * this function used to — made a partially-failed import indistinguishable from
 * a clean one at every downstream door.
 */
export async function handleImportCorpus(
  job: PgBoss.Job<ImportCorpusPayload>
): Promise<ImportCorpusResult | null> {
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
    const result = (await handler(job.data)) ?? null;
    logger.info(
      {
        source,
        status: "completed",
        durationMs: Date.now() - startedAt,
        workspaceId,
        total: items?.length ?? 0,
        proposalId: result?.proposalId ?? null,
        filesProcessed: result?.filesProcessed ?? null,
        filesFailed: result?.filesFailed ?? null,
      },
      "Corpus import telemetry"
    );
    return result;
  } catch (err) {
    logger.error({ err, workspaceId, userId, source }, "Corpus import failed");
    throw err;
  }
}
