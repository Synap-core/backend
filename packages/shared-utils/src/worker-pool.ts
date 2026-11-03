/**
 * THE worker-thread pool: synchronous CPU work OFF the pod's event loop, under
 * a hard deadline.
 *
 * The pod runs its API, MCP, pg-boss workers, crons and reactors in ONE Node
 * process (apps/api/src/index.ts): one synchronous parse of a large body
 * answers nothing else until it ends (3 Nov 2026, a 1.5 h freeze). Node cannot
 * interrupt synchronous work, so the only bound is another thread: a task past
 * its deadline gets its worker TERMINATED and the caller a typed failure, never
 * a hang and never an empty result.
 *
 * Generalised from the web-read extract pool (backend, `extract-pool.ts`), the
 * first user; the CPU pool (`@synap/jobs/utils/cpu-pool.js`: markdown
 * diagnostics, passages, PageRank) is the second. Workers are spawned lazily,
 * `unref`'d while idle (an idle pool never keeps the process alive),
 * heap-capped, and replaced lazily after a timeout or crash. Tasks past the
 * queue cap are refused at once (`busy`, retryable) rather than queued without
 * bound.
 *
 * Wire: the pool posts `{ id, payload }`; a worker answers `{ id, result }`,
 * or `{ id, error }` when its task threw (`serveWorkerTasks`, worker-task.ts:
 * a separate module so a worker loads no logger).
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker, type ResourceLimits } from "node:worker_threads";
import type { WorkerRequest, WorkerResponse } from "./worker-task.js";

export type { WorkerRequest, WorkerResponse } from "./worker-task.js";

/** Why a task did not produce a result. Every one is said, never folded into "empty". */
export type WorkerTaskFailure =
  /** Past its deadline: the worker was terminated. */
  | "timeout"
  /** The queue was full: refused at once, retryable. */
  | "busy"
  /** The worker died or exited mid-task. */
  | "crashed"
  /** The task needed more than the worker's heap cap. */
  | "out_of_memory"
  /** No worker could be started. */
  | "no_worker"
  /** The task itself threw (its message is the detail). */
  | "task_error"
  /** The pool was shut down while the task waited or ran. */
  | "shut_down";

export type WorkerTaskOutcome<R> =
  | { ok: true; value: R }
  | { ok: false; failure: WorkerTaskFailure; detail: string };

/** What the pool logs through (a pino logger fits); injected, so this module loads no config. */
export interface WorkerPoolLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface WorkerPoolOptions<P> {
  /** Where a timeout, a crash or a worker that cannot start is logged. */
  logger: WorkerPoolLogger;
  /** Starts one worker with these limits (see {@link moduleWorker}). */
  newWorker: (resourceLimits: ResourceLimits) => Worker;
  /** Workers alive at most. */
  size: number;
  /** Tasks waiting for a worker at most; more are refused (`busy`). */
  queueMax: number;
  /** Heap of one worker, MB: a task that needs more fails, the pod does not OOM. */
  heapMb: number;
  /** Deadline of a task that names none, ms. */
  deadlineMs: number;
  /** What a log line says about a task (never the payload itself). */
  describe?: (payload: P) => Record<string, unknown>;
}

export interface WorkerPool<P, R> {
  /** Runs `payload` in a worker. Never throws, never hangs. */
  run(
    payload: P,
    opts?: { deadlineMs?: number }
  ): Promise<WorkerTaskOutcome<R>>;
  /** Terminates every worker; waiting and running tasks answer `shut_down`. */
  shutdown(): Promise<void>;
}

interface Task<P, R> {
  id: number;
  payload: P;
  deadlineMs: number;
  resolve: (outcome: WorkerTaskOutcome<R>) => void;
}

interface Slot<P, R> {
  worker: Worker;
  task: Task<P, R> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createWorkerPool<P, R>(
  opts: WorkerPoolOptions<P>
): WorkerPool<P, R> {
  const { logger } = opts;
  const slots: Slot<P, R>[] = [];
  const queue: Task<P, R>[] = [];
  let nextId = 1;

  const failed = (
    failure: WorkerTaskFailure,
    detail: string
  ): WorkerTaskOutcome<R> => ({ ok: false, failure, detail });

  function settle(slot: Slot<P, R>, outcome: WorkerTaskOutcome<R>): void {
    const task = slot.task;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    slot.worker.unref();
    task?.resolve(outcome);
  }

  /** Drop a worker (timed out, crashed, exited) and answer its task. */
  function retire(slot: Slot<P, R>, outcome: WorkerTaskOutcome<R>): void {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    settle(slot, outcome);
    void slot.worker.terminate().catch(() => undefined);
    pump();
  }

  function spawn(): Slot<P, R> {
    const worker = opts.newWorker({ maxOldGenerationSizeMb: opts.heapMb });
    const slot: Slot<P, R> = { worker, task: null, timer: null };
    worker.on("message", (msg: WorkerResponse<R>) => {
      if (!slot.task || msg.id !== slot.task.id) return;
      settle(
        slot,
        msg.error !== undefined
          ? failed("task_error", msg.error)
          : { ok: true, value: msg.result as R }
      );
      pump();
    });
    worker.on("error", (err) => {
      const oom =
        (err as { code?: unknown }).code === "ERR_WORKER_OUT_OF_MEMORY";
      logger.warn(
        { err, ...(slot.task ? opts.describe?.(slot.task.payload) : {}) },
        oom ? "a worker ran out of its heap" : "a worker crashed"
      );
      retire(
        slot,
        oom
          ? failed("out_of_memory", `over the ${opts.heapMb} MB worker heap`)
          : failed("crashed", err.name)
      );
    });
    worker.on("exit", () => {
      if (slots.includes(slot)) retire(slot, failed("crashed", "exited"));
    });
    worker.unref();
    slots.push(slot);
    return slot;
  }

  function start(slot: Slot<P, R>, task: Task<P, R>): void {
    slot.task = task;
    slot.worker.ref(); // a running task keeps the process alive
    slot.timer = setTimeout(() => {
      logger.warn(
        { deadlineMs: task.deadlineMs, ...opts.describe?.(task.payload) },
        "a worker task ran past its deadline — worker terminated"
      );
      retire(slot, failed("timeout", `${task.deadlineMs} ms deadline`));
    }, task.deadlineMs);
    slot.worker.postMessage({
      id: task.id,
      payload: task.payload,
    } satisfies WorkerRequest<P>);
  }

  function pump(): void {
    while (queue.length > 0) {
      let slot = slots.find((s) => s.task === null);
      if (!slot && slots.length < opts.size) {
        try {
          slot = spawn();
        } catch (err) {
          logger.error({ err }, "a worker could not start");
          for (const t of queue.splice(0))
            t.resolve(failed("no_worker", "no worker could start"));
          return;
        }
      }
      if (!slot) return;
      start(slot, queue.shift()!);
    }
  }

  return {
    run(payload, runOpts = {}) {
      if (queue.length >= opts.queueMax) {
        return Promise.resolve(
          failed("busy", `${opts.queueMax} tasks already wait`)
        );
      }
      return new Promise((resolve) => {
        queue.push({
          id: nextId++,
          payload,
          deadlineMs: runOpts.deadlineMs ?? opts.deadlineMs,
          resolve,
        });
        pump();
      });
    },
    async shutdown() {
      for (const t of queue.splice(0))
        t.resolve(failed("shut_down", "the pool was shut down"));
      const all = slots.splice(0);
      await Promise.all(
        all.map((s) => {
          settle(s, failed("shut_down", "the pool was shut down"));
          return s.worker.terminate();
        })
      );
    },
  };
}

/**
 * The worker module `entry` (`"./extract-worker"`, no extension) next to the
 * module at `callerUrl` (pass `import.meta.url`): its built `.js` in a build,
 * or — when the caller runs from TypeScript source (tsx dev, vitest) — a
 * bootstrap that registers tsx's loader in the worker, then imports the `.ts`.
 * A bundled caller (tsup) resolves next to its bundle, so the worker must be
 * an entry of that bundle too.
 */
export function moduleWorker(
  callerUrl: string,
  entry: string,
  resourceLimits: ResourceLimits
): Worker {
  const options = { resourceLimits };
  if (!callerUrl.endsWith(".ts")) {
    return new Worker(new URL(`${entry}.js`, callerUrl), options);
  }
  // tsx's ESM api (its `import` condition; `require.resolve` names the .cjs).
  const tsxApi = pathToFileURL(
    createRequire(callerUrl)
      .resolve("tsx/esm/api")
      .replace(/\.cjs$/, ".mjs")
  ).href;
  const target = new URL(`${entry}.ts`, callerUrl).href;
  const bootstrap = `import(${JSON.stringify(tsxApi)}).then((m) => { m.register(); return import(${JSON.stringify(target)}); });`;
  return new Worker(bootstrap, { ...options, eval: true });
}
