/**
 * Worker-thread entry of the page extractor. Receives `{id, html, url}`,
 * answers `{id, outcome}`. Nothing else runs here: no network, no database,
 * no logger — the pool (extract-pool.ts) logs and enforces the deadline.
 * Built as its own entry (`dist/extract-worker.js`, tsup.config.ts).
 */

import { parentPort } from "node:worker_threads";
import { extractDetailed, type ExtractOutcome } from "./extract.js";

export interface ExtractRequest {
  id: number;
  html: string;
  url: string;
}

export interface ExtractResponse {
  id: number;
  outcome: ExtractOutcome;
}

parentPort?.on("message", (req: ExtractRequest) => {
  let outcome: ExtractOutcome;
  try {
    outcome = extractDetailed(req.html, req.url);
  } catch (err) {
    outcome = {
      read: {
        status: "failed",
        error: `extract_failed: ${err instanceof Error ? err.name : typeof err}`,
      },
    };
  }
  parentPort?.postMessage({ id: req.id, outcome } satisfies ExtractResponse);
});
