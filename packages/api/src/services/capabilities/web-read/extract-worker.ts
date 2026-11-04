/**
 * Worker-thread entry of the page extractor. Receives `{html, url}`, answers
 * the extraction's outcome (the pool's wire: `serveWorkerTasks`). Nothing
 * else runs here: no network, no database, no logger — the pool
 * (extract-pool.ts) logs and enforces the deadline.
 * Built as its own entry (`dist/extract-worker.js`, tsup.config.ts).
 */

import { serveWorkerTasks } from "@synap/shared-utils/worker-task";
import { extractDetailed, type ExtractOutcome } from "./extract.js";

export type { ExtractOutcome };

export interface ExtractRequest {
  html: string;
  url: string;
}

serveWorkerTasks((req: ExtractRequest): ExtractOutcome => {
  try {
    return extractDetailed(req.html, req.url);
  } catch (err) {
    return {
      read: {
        status: "failed",
        error: `extract_failed: ${err instanceof Error ? err.name : typeof err}`,
      },
    };
  }
});
