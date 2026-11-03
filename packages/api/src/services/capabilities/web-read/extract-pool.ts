/**
 * `extractPage` — page extraction OFF the event loop, under a hard deadline.
 *
 * defuddle on a linkedom DOM is super-linear on hostile markup (2 000 nested
 * `<div>` ≈ 26 s, 3 000 empty sibling `<div>` ≈ 3.6 s, measured), and one URL
 * is enough to reach it from capture, `web.read`, the Library read and Build.
 * So the extractor runs in a small pool of worker threads; a run past its
 * deadline gets its worker TERMINATED (a synchronous loop cannot be
 * cancelled any other way) and answers `failed: extract_timeout` — a retry
 * question, never a hang and never an empty read.
 *
 * Why a pool and not one worker per call: spawning a worker and importing
 * defuddle + linkedom costs ≈ 320 ms (measured), paid on every read; a
 * long-lived worker pays it once. Workers are spawned lazily, `unref`'d (an
 * idle pool never keeps the process alive), heap-capped, and replaced
 * lazily after a timeout or crash. Tasks past the queue cap are refused at
 * once (`extract_busy`, retryable) rather than queued without bound.
 *
 * The pool itself is THE worker pool (`@synap/shared-utils/worker-pool`,
 * generalised from this file); this module names its worker, its limits and
 * how a failed task reads as a page read.
 */

import type { ResourceLimits } from "node:worker_threads";
import { createLogger } from "@synap-core/core";
import type { UrlReadFailureClass } from "@synap-core/types/url-read";
import {
  createWorkerPool,
  moduleWorker,
  type WorkerTaskOutcome,
} from "@synap/shared-utils/worker-pool";
import type { SiteRead } from "./adapter.js";
import type { ExtractRequest, ExtractOutcome } from "./extract-worker.js";
import { EXTRACT_DEADLINE_MS, WEB_READ_PAGE_BYTES_MAX } from "./limits.js";

const logger = createLogger({ module: "web-read/extract-pool" });

/** Workers alive at most (each holds defuddle + linkedom, ≈ 40 MB). */
const POOL_SIZE = 2;
/** Extractions waiting for a worker at most; more are refused, retryable. */
const QUEUE_MAX = 16;
/** Heap of one worker: a page that needs more is a failed read, not an OOM pod. */
const WORKER_HEAP_MB = 256;

export const EXTRACT_TIMEOUT_ERROR = "extract_timeout";
const EXTRACT_BUSY_ERROR = "extract_busy";

export interface ExtractPageOptions {
  /** Default {@link EXTRACT_DEADLINE_MS}. */
  deadlineMs?: number;
}

const loggedDefuddleErrors = new Set<string>();

/**
 * The bundled `extract-worker.js` next to this module in a build (a tsup
 * entry: a bundle resolves next to itself), its `.ts` under tsx / vitest.
 */
function newExtractWorker(resourceLimits: ResourceLimits) {
  return moduleWorker(import.meta.url, "./extract-worker", resourceLimits);
}

const pool = createWorkerPool<ExtractRequest, ExtractOutcome>({
  logger,
  newWorker: newExtractWorker,
  size: POOL_SIZE,
  queueMax: QUEUE_MAX,
  heapMb: WORKER_HEAP_MB,
  deadlineMs: EXTRACT_DEADLINE_MS,
  describe: (req) => ({ url: req.url, bytes: req.html.length }),
});

/**
 * A failed extraction, classed: the pool's own trouble (busy, past the
 * deadline, a worker that died or never started) is transient — a later try
 * can read the page; a page that blew the worker's heap is not.
 */
function failed(error: string, errorClass: UrlReadFailureClass): SiteRead {
  return { status: "failed", error, errorClass };
}

function asRead(
  outcome: WorkerTaskOutcome<ExtractOutcome>,
  url: string
): SiteRead {
  if (outcome.ok) {
    const { defuddleError } = outcome.value;
    if (defuddleError && !loggedDefuddleErrors.has(defuddleError)) {
      loggedDefuddleErrors.add(defuddleError);
      logger.warn(
        { error: defuddleError, url },
        "web read: the DOM extractor failed — pages read with the plain-text pass (logged once per error)"
      );
    }
    return outcome.value.read;
  }
  switch (outcome.failure) {
    case "busy":
      return failed(EXTRACT_BUSY_ERROR, "extract_busy");
    case "timeout":
      return failed(EXTRACT_TIMEOUT_ERROR, "extract_timeout");
    case "out_of_memory":
      return failed("extract_failed: out_of_memory", "unknown");
    case "no_worker":
      return failed("extract_failed: no worker", "extract_failed");
    case "shut_down":
      return failed("extract_failed: shut down", "extract_failed");
    case "crashed":
    case "task_error":
      return failed(`extract_failed: ${outcome.detail}`, "extract_failed");
  }
}

/**
 * Extract `html` (the page at `url`) into a read, in a worker, within the
 * deadline. Never throws, never hangs: past the deadline the read is
 * `failed: extract_timeout`; with the queue full, `failed: extract_busy`.
 */
export async function extractPage(
  html: string,
  url: string,
  opts: ExtractPageOptions = {}
): Promise<SiteRead> {
  const outcome = await pool.run(
    { html: html.slice(0, WEB_READ_PAGE_BYTES_MAX), url },
    { deadlineMs: opts.deadlineMs ?? EXTRACT_DEADLINE_MS }
  );
  return asRead(outcome, url);
}

/** Tests: terminate every worker (the next extraction spawns afresh). */
export async function shutdownExtractPool(): Promise<void> {
  await pool.shutdown();
}
