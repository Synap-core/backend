/**
 * A worker process serves /health and nothing else (plan P6): the routes of
 * the API (tRPC, Hub, MCP, auth) answer 404 there, and /health is 503 until
 * its pg-boss works jobs.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createWorkerHealthApp, httpFetchFor } from "./worker-health.js";

const state = { bossStarted: true, eventLoop: { p99Ms: 12 } };
const workerApp = () => createWorkerHealthApp(() => state);

describe("the worker's HTTP", () => {
  it("answers /health with its role and event loop, 200 once jobs run", async () => {
    state.bossStarted = true;
    const res = await workerApp().request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.role).toBe("worker");
    expect(body.jobs).toBe("running");
    expect(body.eventLoop).toEqual({ p99Ms: 12 });
  });

  it("is unhealthy (503) while its pg-boss does not run", async () => {
    state.bossStarted = false;
    const res = await workerApp().request("/health");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { jobs: string }).jobs).toBe("not-running");
    state.bossStarted = true;
  });

  it("serves no route of the API", async () => {
    for (const path of [
      "/trpc/users.me",
      "/api/hub/entities",
      "/mcp",
      "/api/auth/whoami",
      "/status/release",
      "/",
    ]) {
      const res = await workerApp().request(path);
      expect(res.status, path).toBe(404);
    }
    const post = await workerApp().request("/mcp", { method: "POST" });
    expect(post.status).toBe(404);
  });
});

describe("httpFetchFor", () => {
  const full = new Hono();
  full.get("/trpc/x", (c) => c.text("full"));

  it("serves the whole app for all and api", async () => {
    for (const role of ["all", "api"] as const) {
      const fetch = httpFetchFor(role, full, workerApp);
      const res = await fetch(new Request("http://x/trpc/x"));
      expect(res.status, role).toBe(200);
    }
  });

  it("serves only /health for worker", async () => {
    const fetch = httpFetchFor("worker", full, workerApp);
    expect((await fetch(new Request("http://x/trpc/x"))).status).toBe(404);
    expect((await fetch(new Request("http://x/health"))).status).toBe(200);
  });
});
