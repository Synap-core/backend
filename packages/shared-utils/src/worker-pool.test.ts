/**
 * THE worker pool (worker-pool.ts): every way a task ends is said, never
 * folded into an empty result, and the event loop keeps running while a
 * worker spins. The workers here are eval'd one-liners, so the pool's own
 * mechanics are tested without any real task.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { createWorkerPool, type WorkerPool } from "./worker-pool.js";

/** A worker answering `{ id, payload }` like `serveWorkerTasks`, by `kind`. */
const WORKER = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ id, payload }) => {
  if (payload.kind === "spin") { const end = Date.now() + payload.ms; while (Date.now() < end) {} }
  if (payload.kind === "throw") { parentPort.postMessage({ id, error: "Error: bad input" }); return; }
  if (payload.kind === "exit") process.exit(3);
  if (payload.kind === "hog") { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }
  parentPort.postMessage({ id, result: { echoed: payload.value ?? null } });
});`;

type Payload = { kind: string; value?: unknown; ms?: number };
let pool: WorkerPool<Payload, { echoed: unknown }> | null = null;

function newPool(over: Partial<{ size: number; queueMax: number }> = {}) {
  pool = createWorkerPool<Payload, { echoed: unknown }>({
    logger: { warn: () => undefined, error: () => undefined },
    newWorker: (resourceLimits) =>
      new Worker(WORKER, { eval: true, resourceLimits }),
    size: over.size ?? 1,
    queueMax: over.queueMax ?? 4,
    heapMb: 32,
    deadlineMs: 5_000,
  });
  return pool;
}

afterEach(async () => {
  await pool?.shutdown();
  pool = null;
});

describe("worker pool", () => {
  it("runs a task and returns its result as sent", async () => {
    const out = await newPool().run({ kind: "echo", value: { a: [1, "x"] } });
    expect(out).toEqual({ ok: true, value: { echoed: { a: [1, "x"] } } });
  });

  it("past the deadline: the worker is terminated, `timeout`, the loop kept running, the next task runs", async () => {
    const p = newPool();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const t0 = performance.now();
    const out = await p.run({ kind: "spin", ms: 5_000 }, { deadlineMs: 200 });
    clearInterval(timer);
    expect(out).toEqual({
      ok: false,
      failure: "timeout",
      detail: "200 ms deadline",
    });
    // Answered at the deadline, not after the 5 s spin.
    expect(performance.now() - t0).toBeLessThan(2_000);
    // The main thread ran its timer while the worker spun.
    expect(ticks).toBeGreaterThanOrEqual(5);
    expect(await p.run({ kind: "echo", value: 1 })).toEqual({
      ok: true,
      value: { echoed: 1 },
    });
  });

  it("a task that throws is `task_error` with its message", async () => {
    expect(await newPool().run({ kind: "throw" })).toEqual({
      ok: false,
      failure: "task_error",
      detail: "Error: bad input",
    });
  });

  it("a worker that exits mid-task is `crashed`, and a fresh one takes the next", async () => {
    const p = newPool();
    const out = await p.run({ kind: "exit" });
    expect(out).toMatchObject({ ok: false, failure: "crashed" });
    expect(await p.run({ kind: "echo", value: 2 })).toMatchObject({ ok: true });
  });

  it("a task over the heap cap is `out_of_memory`, not a dead process", async () => {
    const out = await newPool().run({ kind: "hog" });
    expect(out).toEqual({
      ok: false,
      failure: "out_of_memory",
      detail: "over the 32 MB worker heap",
    });
  });

  it("past the queue cap: refused at once, `busy`", async () => {
    const p = newPool({ size: 1, queueMax: 1 });
    const running = p.run({ kind: "spin", ms: 300 });
    // Let the first task leave the queue for the worker.
    await new Promise((r) => setTimeout(r, 0));
    const waiting = p.run({ kind: "echo", value: "w" });
    expect(await p.run({ kind: "echo" })).toEqual({
      ok: false,
      failure: "busy",
      detail: "1 tasks already wait",
    });
    expect(await running).toMatchObject({ ok: true });
    expect(await waiting).toEqual({ ok: true, value: { echoed: "w" } });
  });
});
