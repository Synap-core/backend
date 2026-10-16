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
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createLogger } from "@synap-core/core";
import type { UrlReadFailureClass } from "@synap-core/types/url-read";
import type { SiteRead } from "./adapter.js";
import type { ExtractRequest, ExtractResponse } from "./extract-worker.js";
import { EXTRACT_DEADLINE_MS, WEB_READ_PAGE_BYTES_MAX } from "./limits.js";

const logger = createLogger({ module: "web-read/extract-pool" });

/** Workers alive at most (each holds defuddle + linkedom, ≈ 40 MB). */
const POOL_SIZE = 2;
/** Extractions waiting for a worker at most; more are refused, retryable. */
const QUEUE_MAX = 16;
/** Heap of one worker: a page that needs more is a failed read, not an OOM pod. */
const WORKER_HEAP_MB = 256;

export const EXTRACT_TIMEOUT_ERROR = "extract_timeout";
export const EXTRACT_BUSY_ERROR = "extract_busy";

export interface ExtractPageOptions {
  /** Default {@link EXTRACT_DEADLINE_MS}. */
  deadlineMs?: number;
}

interface Task {
  id: number;
  html: string;
  url: string;
  deadlineMs: number;
  resolve: (read: SiteRead) => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const slots: Slot[] = [];
const queue: Task[] = [];
let nextId = 1;
const loggedDefuddleErrors = new Set<string>();

/**
 * The worker next to this module: the bundled `extract-worker.js` in a build
 * (a tsup entry), or — when this module runs from TypeScript source (tsx dev,
 * vitest) — a bootstrap that registers tsx's loader in the worker, then
 * imports `extract-worker.ts`.
 */
function newExtractWorker(): Worker {
  const options = {
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
  };
  const here = import.meta.url;
  if (!here.endsWith(".ts")) {
    return new Worker(new URL("./extract-worker.js", here), options);
  }
  // tsx's ESM api (its `import` condition; `require.resolve` names the .cjs).
  const tsxApi = pathToFileURL(
    createRequire(here)
      .resolve("tsx/esm/api")
      .replace(/\.cjs$/, ".mjs")
  ).href;
  const entry = new URL("./extract-worker.ts", here).href;
  const bootstrap = `import(${JSON.stringify(tsxApi)}).then((m) => { m.register(); return import(${JSON.stringify(entry)}); });`;
  return new Worker(bootstrap, { ...options, eval: true });
}

/**
 * A failed extraction, classed: the pool's own trouble (busy, past the
 * deadline, a worker that died or never started) is transient — a later try
 * can read the page; a page that blew the worker's heap is not.
 */
function failed(error: string, errorClass: UrlReadFailureClass): SiteRead {
  return { status: "failed", error, errorClass };
}

function settle(slot: Slot, read: SiteRead): void {
  const task = slot.task;
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  slot.task = null;
  slot.worker.unref();
  task?.resolve(read);
}

/** Drop a worker (timed out, crashed, exited) and answer its task. */
function retire(slot: Slot, read: SiteRead): void {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  settle(slot, read);
  void slot.worker.terminate().catch(() => undefined);
  pump();
}

function spawn(): Slot {
  const worker = newExtractWorker();
  const slot: Slot = { worker, task: null, timer: null };
  worker.on("message", (msg: ExtractResponse) => {
    if (!slot.task || msg.id !== slot.task.id) return;
    const { outcome } = msg;
    if (
      outcome.defuddleError &&
      !loggedDefuddleErrors.has(outcome.defuddleError)
    ) {
      loggedDefuddleErrors.add(outcome.defuddleError);
      logger.warn(
        { error: outcome.defuddleError, url: slot.task.url },
        "web read: the DOM extractor failed — pages read with the plain-text pass (logged once per error)"
      );
    }
    settle(slot, outcome.read);
    pump();
  });
  worker.on("error", (err) => {
    logger.warn({ err }, "web read: an extraction worker crashed");
    const oom = (err as { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY";
    retire(
      slot,
      failed(`extract_failed: ${err.name}`, oom ? "unknown" : "extract_failed")
    );
  });
  worker.on("exit", () => {
    if (slots.includes(slot))
      retire(slot, failed("extract_failed: exited", "extract_failed"));
  });
  worker.unref();
  slots.push(slot);
  return slot;
}

function run(slot: Slot, task: Task): void {
  slot.task = task;
  slot.worker.ref(); // a running extraction keeps the process alive
  slot.timer = setTimeout(() => {
    logger.warn(
      { url: task.url, deadlineMs: task.deadlineMs, bytes: task.html.length },
      "web read: extraction past its deadline — worker terminated"
    );
    retire(slot, failed(EXTRACT_TIMEOUT_ERROR, "extract_timeout"));
  }, task.deadlineMs);
  slot.worker.postMessage({
    id: task.id,
    html: task.html,
    url: task.url,
  } satisfies ExtractRequest);
}

function pump(): void {
  while (queue.length > 0) {
    let slot = slots.find((s) => s.task === null);
    if (!slot && slots.length < POOL_SIZE) {
      try {
        slot = spawn();
      } catch (err) {
        logger.error({ err }, "web read: an extraction worker could not start");
        for (const t of queue.splice(0))
          t.resolve(failed("extract_failed: no worker", "extract_failed"));
        return;
      }
    }
    if (!slot) return;
    run(slot, queue.shift()!);
  }
}

/**
 * Extract `html` (the page at `url`) into a read, in a worker, within the
 * deadline. Never throws, never hangs: past the deadline the read is
 * `failed: extract_timeout`; with the queue full, `failed: extract_busy`.
 */
export function extractPage(
  html: string,
  url: string,
  opts: ExtractPageOptions = {}
): Promise<SiteRead> {
  if (queue.length >= QUEUE_MAX) {
    return Promise.resolve(failed(EXTRACT_BUSY_ERROR, "extract_busy"));
  }
  return new Promise<SiteRead>((resolve) => {
    queue.push({
      id: nextId++,
      html: html.slice(0, WEB_READ_PAGE_BYTES_MAX),
      url,
      deadlineMs: opts.deadlineMs ?? EXTRACT_DEADLINE_MS,
      resolve,
    });
    pump();
  });
}

/** Tests: terminate every worker (the next extraction spawns afresh). */
export async function shutdownExtractPool(): Promise<void> {
  const all = slots.splice(0);
  await Promise.all(
    all.map((s) => {
      settle(s, failed("extract_failed: shut down", "extract_failed"));
      return s.worker.terminate();
    })
  );
}
