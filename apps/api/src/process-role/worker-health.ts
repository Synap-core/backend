/**
 * The HTTP a worker process serves (SYNAP_PROCESS_ROLE=worker, plan P6):
 * `/health` and nothing else, on the same port, for its container's
 * healthcheck and for `synap heal`'s probe (which reads `eventLoop`).
 *
 * A worker answers 200 once its pg-boss runs (its workers are registered) and
 * 503 before that or when pg-boss failed to start: a worker that works no job
 * is unhealthy, so Docker marks it and heal restarts it, where the one-process
 * backend logged the failure and served on.
 *
 * Every other path is a 404: no tRPC, no Hub, no MCP, no auth proxy. Caddy
 * routes no traffic to the worker service; this keeps it so if one ever did.
 */

import { Hono } from "hono";
import type { ProcessRole } from "@synap/jobs";

export interface WorkerHealthState {
  bossStarted: boolean;
  eventLoop: unknown;
}

export function createWorkerHealthApp(read: () => WorkerHealthState): Hono {
  const app = new Hono();
  app.get("/health", (c) => {
    const s = read();
    return c.json(
      {
        status: s.bossStarted ? "ok" : "degraded",
        role: "worker",
        jobs: s.bossStarted ? "running" : "not-running",
        timestamp: new Date().toISOString(),
        buildSha: process.env.SYNAP_GIT_SHA || "unknown",
        eventLoop: s.eventLoop,
      },
      s.bossStarted ? 200 : 503
    );
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}

/** The fetch handler a role serves: the whole app, or the worker's /health. */
export function httpFetchFor(
  role: ProcessRole,
  full: { fetch: Hono["fetch"] },
  worker: () => { fetch: Hono["fetch"] }
): Hono["fetch"] {
  return role === "worker" ? worker().fetch : full.fetch;
}
