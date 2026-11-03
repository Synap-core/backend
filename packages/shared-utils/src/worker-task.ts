/**
 * The worker side of the pool's wire (worker-pool.ts). Its own module so a
 * worker entry imports nothing but `node:worker_threads` from here: no
 * logger, no config.
 */

import { parentPort } from "node:worker_threads";

export interface WorkerRequest<P> {
  id: number;
  payload: P;
}

export type WorkerResponse<R> =
  | { id: number; result: R; error?: undefined }
  | { id: number; result?: undefined; error: string };

/**
 * The worker side of the wire: answer each `{ id, payload }` with
 * `handle(payload)`, or with `{ id, error }` when it throws. Call once, at a
 * worker entry's top level. Nothing else runs in a worker: no network, no
 * database, no logger — the pool logs and enforces the deadline.
 */
export function serveWorkerTasks<P, R>(handle: (payload: P) => R): void {
  const port = parentPort;
  if (!port) throw new Error("serveWorkerTasks: not in a worker thread");
  port.on("message", (req: WorkerRequest<P>) => {
    let res: WorkerResponse<R>;
    try {
      res = { id: req.id, result: handle(req.payload) };
    } catch (err) {
      res = {
        id: req.id,
        error:
          err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
    port.postMessage(res);
  });
}
