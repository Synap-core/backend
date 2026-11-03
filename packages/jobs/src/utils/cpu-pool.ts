/**
 * The pod's CPU pool: synchronous CPU work on stored or agent content runs in
 * worker threads, OFF the one event loop the API, MCP, pg-boss workers and
 * crons share (plan "pod resilience" P2, after the 3 Nov 2026 freeze).
 *
 * What runs here (cpu-tasks.ts): the content half of a document's diagnostics
 * (markdown parse + embed scan, api `diagnoseDocument`, on read and on write),
 * recall passages (the document-passages worker, the synthesis excerpt) and
 * PageRank (the pagerank-centrality worker). Measured on a loaded dev Mac: the
 * diagnostics parse costs 30 ms at 4 KB, 92 ms at 16 KB and grows faster than
 * the input (875 ms at 32 KB of embed-heavy markdown); PageRank 0.6 s at 10k
 * nodes / 50k edges, 6.7 s at 50k / 300k.
 *
 * Built on THE worker pool (`@synap/shared-utils/worker-pool`, the web-read
 * extract pool's): 2 workers, 256 MB heap each, a deadline that TERMINATES
 * the thread. A task that does not finish is a typed failure (`CpuTaskError`,
 * its `failure` says which), never an empty result: diagnostics read it as
 * `{ items: null, error }`, passages keep the old ones, PageRank keeps the old
 * scores.
 *
 * INLINE BELOW A SIZE: a markdown input of at most `CPU_INLINE_MAX_CHARS`
 * (1,000 chars) and a graph of at most `CPU_INLINE_MAX_EDGES` (2,000 edges)
 * run on the caller's thread. Measured: the parse costs 2.3 ms at 500 chars and
 * 4.7 ms at 1 KB, while a round trip to a worker (input and result cloned)
 * costs 0.4-3 ms, so the hop only pays from about there; and a bounded
 * few-millisecond task never needs a deadline. Most documents an agent writes
 * a section of, and most unit tests, stay inline.
 */

import type { ResourceLimits } from "node:worker_threads";
import { envInt } from "@synap/shared-utils";
import {
  createWorkerPool,
  moduleWorker,
  type WorkerTaskFailure,
} from "@synap/shared-utils/worker-pool";
import {
  diagnoseTask,
  pagerankTask,
  passagesTask,
  type CpuTask,
  type CpuTaskOf,
  type CpuTaskResult,
  type DiagnoseResult,
  type PassageWithProse,
} from "./cpu-tasks.js";
import type { Passage } from "@synap-core/markdown-core/sections";
import type { Edge } from "./pagerank.js";

export type { DiagnoseResult, PassageWithProse } from "./cpu-tasks.js";

/** Markdown at most this long (chars) is parsed inline (header: measured). */
export const CPU_INLINE_MAX_CHARS = 1_000;
/** A graph with at most this many edges is ranked inline (≈ 20 ms). */
export const CPU_INLINE_MAX_EDGES = 2_000;

/** Workers alive at most (each holds the markdown parser, ≈ 30 MB). */
const POOL_SIZE = 2;
/** Tasks waiting for a worker at most; more are refused at once (`busy`). */
const QUEUE_MAX = 64;
/** Heap of one worker: a body that needs more is a failed task, not an OOM pod. */
const WORKER_HEAP_MB = 256;

/** Deadline of a markdown task, ms (`SYNAP_CPU_TASK_DEADLINE_MS`, default 10 s). */
export function cpuTaskDeadlineMs(
  env: Record<string, string | undefined> = process.env
): number {
  return envInt(env, "SYNAP_CPU_TASK_DEADLINE_MS", {
    default: 10_000,
    min: 100,
    max: 600_000,
  });
}

/** Deadline of one user's PageRank, ms (`SYNAP_PAGERANK_DEADLINE_MS`, default 60 s). */
export function pageRankDeadlineMs(
  env: Record<string, string | undefined> = process.env
): number {
  return envInt(env, "SYNAP_PAGERANK_DEADLINE_MS", {
    default: 60_000,
    min: 100,
    max: 3_600_000,
  });
}

const TASK_WORDS: Record<CpuTask["kind"], string> = {
  diagnose: "the markdown parse for diagnostics",
  passages: "cutting the body into passages",
  segment: "cutting the body into passages",
  pagerank: "PageRank",
};

const FAILURE_WORDS: Record<WorkerTaskFailure, string> = {
  timeout: "ran past its deadline and was stopped",
  busy: "was refused: the CPU pool is full",
  crashed: "stopped: its worker crashed",
  out_of_memory: "ran out of memory and was stopped",
  no_worker: "could not start a worker",
  task_error: "failed",
  shut_down: "was cancelled: the CPU pool shut down",
};

/** Failures a later try can get past (the pool's state, not the input's). */
const TRANSIENT: ReadonlySet<WorkerTaskFailure> = new Set([
  "busy",
  "crashed",
  "no_worker",
  "shut_down",
]);

/** A CPU task that produced no result, and why. */
export class CpuTaskError extends Error {
  readonly task: CpuTask["kind"];
  readonly failure: WorkerTaskFailure;
  constructor(
    task: CpuTask["kind"],
    failure: WorkerTaskFailure,
    detail: string
  ) {
    super(`${TASK_WORDS[task]} ${FAILURE_WORDS[failure]} (${detail})`);
    this.name = "CpuTaskError";
    this.task = task;
    this.failure = failure;
  }
  /** True when the same input may succeed later (busy, a crashed worker…). */
  get transient(): boolean {
    return TRANSIENT.has(this.failure);
  }
}

function newCpuWorker(resourceLimits: ResourceLimits) {
  return moduleWorker(import.meta.url, "./cpu-worker", resourceLimits);
}

const pool = createWorkerPool<CpuTask, CpuTaskResult[CpuTask["kind"]]>({
  name: "cpu",
  newWorker: newCpuWorker,
  size: POOL_SIZE,
  queueMax: QUEUE_MAX,
  heapMb: WORKER_HEAP_MB,
  deadlineMs: cpuTaskDeadlineMs(),
  describe: (task) =>
    task.kind === "pagerank"
      ? { task: task.kind, edges: task.edges.length }
      : { task: task.kind, chars: task.markdown.length },
});

export interface CpuRunOptions {
  /** Overrides the task's deadline (tests, a caller with its own budget). */
  deadlineMs?: number;
}

/**
 * Runs `task` inline when `inline` is given (a tiny input), else in a worker.
 * Throws `CpuTaskError` when the worker produced no result.
 */
async function offLoop<K extends CpuTask["kind"]>(
  task: CpuTaskOf<K>,
  inline: (() => CpuTaskResult[K]) | null,
  deadlineMs: number
): Promise<CpuTaskResult[K]> {
  if (inline) return inline();
  const outcome = await pool.run(task, { deadlineMs });
  if (outcome.ok) return outcome.value as CpuTaskResult[K];
  throw new CpuTaskError(task.kind, outcome.failure, outcome.detail);
}

const small = (markdown: string) => markdown.length <= CPU_INLINE_MAX_CHARS;

/**
 * The content half of a document's diagnostics: the grammar diagnostics and
 * the located embeds. Throws `CpuTaskError` when the parse did not finish.
 */
export function diagnoseMarkdownOffLoop(
  markdown: string,
  opts: CpuRunOptions = {}
): Promise<DiagnoseResult> {
  return offLoop(
    { kind: "diagnose", markdown },
    small(markdown) ? () => diagnoseTask(markdown) : null,
    opts.deadlineMs ?? cpuTaskDeadlineMs()
  );
}

/** Recall passages with their prose. Throws `CpuTaskError` when the cut did not finish. */
export function passagesOffLoop(
  markdown: string,
  opts: CpuRunOptions = {}
): Promise<PassageWithProse[]> {
  return offLoop(
    { kind: "passages", markdown },
    small(markdown) ? () => passagesTask(markdown) : null,
    opts.deadlineMs ?? cpuTaskDeadlineMs()
  );
}

/**
 * `segmentPassages` ALWAYS in a worker, for a caller that only sends bodies
 * far over the inline size (the synthesis excerpt: over 4,000 chars).
 */
export function segmentPassagesInWorker(
  markdown: string,
  opts: CpuRunOptions = {}
): Promise<Passage[]> {
  return offLoop(
    { kind: "segment", markdown },
    null,
    opts.deadlineMs ?? cpuTaskDeadlineMs()
  );
}

/** PageRank over `edges` (pagerank.ts). Throws `CpuTaskError` when it did not finish. */
export async function rankGraph(
  edges: Edge[],
  opts: CpuRunOptions = {}
): Promise<Map<string, number>> {
  const pairs = await offLoop(
    { kind: "pagerank", edges },
    edges.length <= CPU_INLINE_MAX_EDGES ? () => pagerankTask(edges) : null,
    opts.deadlineMs ?? pageRankDeadlineMs()
  );
  return new Map(pairs);
}

/** Tests: terminate every worker (the next task spawns afresh). */
export async function shutdownCpuPool(): Promise<void> {
  await pool.shutdown();
}
