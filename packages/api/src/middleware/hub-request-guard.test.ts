/**
 * The Hub request guard on a real Hono app (no database): a slow guarded
 * route answers 503 REQUEST_TIMEOUT at the timeout, an exempt SSE route is
 * never cut, and a key's 9th concurrent request gets 429 TOO_MANY_IN_FLIGHT
 * with Retry-After until one of its running requests settles (success or
 * error). `middleware/hub-request-guard.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  classifyHubRestRequest,
  classifyMcpToolCall,
  hubRequestGuardMiddleware,
  inFlightCount,
  REQUEST_TIMEOUT,
  resetHubInFlightForTests,
  runGuarded,
  TOO_MANY_IN_FLIGHT,
} from "./hub-request-guard.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A deferred the test opens to let held requests finish. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

function app(held: { opened: Promise<void> }) {
  const a = new Hono();
  // Stands in for hub auth: the key the request is counted against.
  a.use("/api/hub/*", async (c, next) => {
    const key = c.req.header("x-test-key");
    if (key) (c.set as (k: string, v: unknown) => void)("apiKeyId", key);
    await next();
  });
  a.use("/api/hub/*", hubRequestGuardMiddleware);
  a.get("/api/hub/slow", async (c) => {
    await sleep(400);
    return c.json({ ok: true });
  });
  a.get("/api/hub/held", async (c) => {
    await held.opened;
    return c.json({ ok: true });
  });
  a.get("/api/hub/held-fails", async () => {
    await held.opened;
    throw new Error("boom");
  });
  a.get("/api/hub/events/stream", (c) =>
    streamSSE(c, async (stream) => {
      await sleep(250);
      await stream.writeSSE({ data: "late-event" });
    })
  );
  // Exempt from the timeout (a long poll): may outlive it.
  a.get("/api/hub/focus-sessions/:id/answers/wait", async (c) => {
    await sleep(250);
    return c.json({ status: "timeout" });
  });
  a.onError((_err, c) => c.json({ error: "handled" }, 500));
  return a;
}

describe("hub request guard", () => {
  beforeEach(() => {
    resetHubInFlightForTests();
    process.env.SYNAP_HUB_REQUEST_TIMEOUT_MS = "100";
  });
  afterEach(() => {
    delete process.env.SYNAP_HUB_REQUEST_TIMEOUT_MS;
    delete process.env.SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY;
  });

  it("a slow guarded request answers 503 REQUEST_TIMEOUT at the timeout", async () => {
    const started = Date.now();
    const res = await app(gate()).request("/api/hub/slow", {
      headers: { "x-test-key": "k1" },
    });
    const took = Date.now() - started;
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe(REQUEST_TIMEOUT);
    expect(body.timeoutMs).toBe(100);
    // Answered at the timeout, not when the 400 ms handler finished.
    expect(took).toBeLessThan(350);
    // No internals: only the fixed fields.
    expect(Object.keys(body).sort()).toEqual(
      ["code", "error", "message", "reasonCode", "timeoutMs"].sort()
    );
  });

  it("an exempt SSE stream is never cut by the timeout", async () => {
    const res = await app(gate()).request("/api/hub/events/stream", {
      headers: { "x-test-key": "k1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // The event written after the timeout still arrives.
    expect(await res.text()).toContain("late-event");
  });

  it("an exempt long poll answers after the timeout with its own answer", async () => {
    const res = await app(gate()).request(
      "/api/hub/focus-sessions/s1/answers/wait",
      { headers: { "x-test-key": "k1" } }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "timeout" });
  });

  // The N+1-th refusal, at the code's default (no env) and at an env override.
  for (const override of [undefined, "5"]) {
    const limit = override
      ? Number(override)
      : // The default with no env (lead, 2026-11-04): one key is shared by
        // ~19 Claude Code sessions and their sub-agents, so 8 refused normal work.
        32;
    it(`refuses a key's request ${limit + 1} with 429 + Retry-After at limit ${limit}${override ? " (env)" : " (default)"}, frees on completion`, async () => {
      process.env.SYNAP_HUB_REQUEST_TIMEOUT_MS = "5000";
      if (override) process.env.SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY = override;
      const held = gate();
      const a = app(held);
      const headers = { "x-test-key": "k1" };
      const full = Array.from({ length: limit }, () =>
        a.request("/api/hub/held", { headers })
      );
      await sleep(20);
      expect(inFlightCount("k1")).toBe(limit);

      const over = await a.request("/api/hub/held", { headers });
      expect(over.status).toBe(429);
      expect(over.headers.get("retry-after")).toBe("1");
      const body = (await over.json()) as Record<string, unknown>;
      expect(body.code).toBe(TOO_MANY_IN_FLIGHT);
      expect(body.limit).toBe(limit);

      // Another key is not affected.
      const other = a.request("/api/hub/held", {
        headers: { "x-test-key": "k2" },
      });
      await sleep(20);
      expect(inFlightCount("k2")).toBe(1);

      held.open();
      const done = await Promise.all([...full, other]);
      expect(done.map((r) => r.status)).toEqual(Array(limit + 1).fill(200));
      expect(inFlightCount("k1")).toBe(0);
      const again = await a.request("/api/hub/held", { headers });
      expect(again.status).toBe(200);
    });
  }

  it("frees the slot when the request fails", async () => {
    process.env.SYNAP_HUB_REQUEST_TIMEOUT_MS = "5000";
    process.env.SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY = "1";
    const held = gate();
    const a = app(held);
    const headers = { "x-test-key": "k1" };
    const first = a.request("/api/hub/held-fails", { headers });
    await sleep(20);
    expect((await a.request("/api/hub/held", { headers })).status).toBe(429);
    held.open();
    expect((await first).status).toBe(500);
    expect(inFlightCount("k1")).toBe(0);
    expect((await a.request("/api/hub/held", { headers })).status).toBe(200);
  });

  it("a timed-out request keeps its slot until its work settles", async () => {
    process.env.SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY = "1";
    const held = gate();
    const a = app(held);
    const headers = { "x-test-key": "k1" };
    expect((await a.request("/api/hub/held", { headers })).status).toBe(503);
    // The work still runs: the key may not start another.
    expect(inFlightCount("k1")).toBe(1);
    expect((await a.request("/api/hub/held", { headers })).status).toBe(429);
    held.open();
    await sleep(20);
    expect(inFlightCount("k1")).toBe(0);
  });

  it("a request with no key is timed but never counted", async () => {
    const res = await app(gate()).request("/api/hub/slow");
    expect(res.status).toBe(503);
    expect(inFlightCount("undefined")).toBe(0);
  });
});

describe("what is exempt", () => {
  it("Hub REST: streams, long polls, uploads and model calls; both bases", () => {
    expect(classifyHubRestRequest("GET", "/api/hub/events/stream")).toBe(
      "stream"
    );
    expect(
      classifyHubRestRequest(
        "GET",
        "/api/hub-protocol/focus-sessions/abc/answers/wait"
      )
    ).toBe("long_poll");
    expect(classifyHubRestRequest("POST", "/api/hub/files")).toBe("upload");
    expect(classifyHubRestRequest("POST", "/api/hub/import/store-unit")).toBe(
      "upload"
    );
    expect(classifyHubRestRequest("POST", "/api/hub/files/e1/transcribe")).toBe(
      "model"
    );
    // Ordinary requests are guarded; the method matters.
    expect(classifyHubRestRequest("GET", "/api/hub/events")).toBeNull();
    expect(classifyHubRestRequest("GET", "/api/hub/files")).toBeNull();
    expect(classifyHubRestRequest("GET", "/api/hub/entities/e1")).toBeNull();
  });

  it("MCP: the long-poll tool, the model tool and every open-world tool", () => {
    const openWorld = new Set(["synap_run_capability"]);
    expect(classifyMcpToolCall("synap_wait_for_answer", openWorld)).toBe(
      "long_poll"
    );
    expect(classifyMcpToolCall("synap_ask", openWorld)).toBe("model");
    expect(classifyMcpToolCall("synap_run_capability", openWorld)).toBe(
      "model"
    );
    expect(classifyMcpToolCall("synap_get_entity", openWorld)).toBeNull();
    expect(classifyMcpToolCall(undefined, openWorld)).toBeNull();
  });

  it("runGuarded: a request whose work rejects frees its slot and rethrows", async () => {
    process.env.SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY = "1";
    resetHubInFlightForTests();
    const answers = { timedOut: () => "timeout", busy: () => "busy" };
    const failing = runGuarded(
      { key: "k", route: "MCP tools/call synap_x", exemption: null },
      async () => {
        await sleep(20);
        throw new Error("boom");
      },
      answers
    );
    expect(inFlightCount("k")).toBe(1);
    await expect(failing).rejects.toThrow("boom");
    await sleep(0);
    expect(inFlightCount("k")).toBe(0);
    delete process.env.SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY;
  });

  it("runGuarded: an exempt long poll is neither timed nor counted", async () => {
    process.env.SYNAP_HUB_REQUEST_TIMEOUT_MS = "50";
    process.env.SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY = "1";
    resetHubInFlightForTests();
    const answers = { timedOut: () => "timeout", busy: () => "busy" };
    const polls = [1, 2].map(() =>
      runGuarded(
        {
          key: "k",
          route: "MCP tools/call synap_wait_for_answer",
          exemption: "long_poll",
        },
        async () => {
          await sleep(120);
          return "answered";
        },
        answers
      )
    );
    expect(await Promise.all(polls)).toEqual(["answered", "answered"]);
    delete process.env.SYNAP_HUB_REQUEST_TIMEOUT_MS;
    delete process.env.SYNAP_HUB_MAX_IN_FLIGHT_PER_KEY;
  });
});
