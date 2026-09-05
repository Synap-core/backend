/**
 * Hub Protocol Idempotency Middleware — Unit Tests (E1.1)
 *
 * Self-contained: spins up a tiny Hono app per test, no DB mocks. The middleware
 * uses an in-memory store, which we reset between tests via the
 * `__resetIdempotencyStoreForTests` escape hatch.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __idempotencyStoreSizeForTests,
  __resetIdempotencyStoreForTests,
  idempotencyMiddleware,
} from "./idempotency.js";

beforeEach(() => {
  __resetIdempotencyStoreForTests();
  // Silence the in-memory backend warning so test output stays clean.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const VALID_KEY = "test-key-12345678"; // 17 chars, well within [8, 256]

type TestVariables = { userId: string };

function buildApp(opts?: Parameters<typeof idempotencyMiddleware>[0]) {
  const app = new Hono<{ Variables: TestVariables }>();
  // Stand-in for the real auth middleware — sets userId so the cache key
  // is deterministic across tests.
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.use("*", idempotencyMiddleware(opts));
  return app;
}

describe("idempotencyMiddleware", () => {
  it("passes through GET requests without consuming the body", async () => {
    const app = buildApp();
    const handler = vi.fn(async (c) => c.json({ ok: true }));
    app.get("/things", handler);

    const res = await app.request("/things", {
      method: "GET",
      headers: { "Idempotency-Key": VALID_KEY },
    });

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    // Read-only requests must NOT carry the replay marker — they didn't go
    // through the cache at all.
    expect(res.headers.get("X-Idempotent-Replay")).toBeNull();
  });

  it("bypasses caching for skipPaths (replay re-invokes handler)", async () => {
    const app = buildApp({ skipPaths: ["/setup/agent"] });
    let invocations = 0;
    app.post("/setup/agent", async (c) => {
      invocations += 1;
      // Simulate a one-shot secret in the response body.
      return c.json({ hubApiKey: `secret-${invocations}` });
    });

    const body = JSON.stringify({ name: "agent-1" });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": VALID_KEY,
    };

    const first = await app.request("/setup/agent", {
      method: "POST",
      headers,
      body,
    });
    const second = await app.request("/setup/agent", {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(invocations).toBe(2); // handler ran twice — never cached
    expect(first.headers.get("X-Idempotent-Replay")).toBeNull();
    expect(second.headers.get("X-Idempotent-Replay")).toBeNull();

    const firstBody = (await first.json()) as { hubApiKey: string };
    const secondBody = (await second.json()) as { hubApiKey: string };
    expect(firstBody.hubApiKey).not.toEqual(secondBody.hubApiKey);
  });

  it("never caches 4xx responses", async () => {
    const app = buildApp();
    let invocations = 0;
    app.post("/things", async (c) => {
      invocations += 1;
      return c.json({ error: "bad" }, 400);
    });

    const body = JSON.stringify({ x: 1 });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": VALID_KEY,
    };

    await app.request("/things", { method: "POST", headers, body });
    await app.request("/things", { method: "POST", headers, body });

    expect(invocations).toBe(2); // 4xx must not be cached
  });

  it("never caches 5xx responses", async () => {
    const app = buildApp();
    let invocations = 0;
    app.post("/things", async (c) => {
      invocations += 1;
      return c.json({ error: "boom" }, 500);
    });

    const body = JSON.stringify({ x: 1 });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": VALID_KEY,
    };

    await app.request("/things", { method: "POST", headers, body });
    await app.request("/things", { method: "POST", headers, body });

    expect(invocations).toBe(2); // 5xx must not be cached either
  });

  it("skips caching when response body matches secretBodyPattern", async () => {
    const app = buildApp();
    let invocations = 0;
    // 2xx response that contains a secret-looking field. Even though the
    // path is NOT in skipPaths, the body pattern should prevent caching.
    app.post("/leak", async (c) => {
      invocations += 1;
      return c.json({ apiKey: `key-${invocations}` });
    });

    const body = JSON.stringify({ x: 1 });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": VALID_KEY,
    };

    const first = await app.request("/leak", { method: "POST", headers, body });
    const second = await app.request("/leak", {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(invocations).toBe(2);
    expect(second.headers.get("X-Idempotent-Replay")).toBeNull();
  });

  it("returns X-Idempotent-Replay: true on a cached replay", async () => {
    const app = buildApp();
    let invocations = 0;
    app.post("/things", async (c) => {
      invocations += 1;
      return c.json({ id: invocations });
    });

    const body = JSON.stringify({ x: 1 });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": VALID_KEY,
    };

    const first = await app.request("/things", {
      method: "POST",
      headers,
      body,
    });
    const second = await app.request("/things", {
      method: "POST",
      headers,
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(invocations).toBe(1); // handler ran once
    expect(first.headers.get("X-Idempotent-Replay")).toBeNull();
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");

    const firstBody = (await first.json()) as { id: number };
    const secondBody = (await second.json()) as { id: number };
    expect(firstBody).toEqual(secondBody);
  });
});

describe("idempotency store bound (memory)", () => {
  // The client mints a FRESH Idempotency-Key per mutating call, so the cache
  // hit rate is ~0 outside a within-call retry and every write allocates a
  // 24h entry. Without a cap the Map grows with write volume for a whole day.
  const MAX_ENTRIES = 5_000;

  async function post(
    app: ReturnType<typeof buildApp>,
    key: string
  ): Promise<Response> {
    return app.request("/things", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ x: 1 }),
    });
  }

  it("never exceeds MAX_ENTRIES under a stream of unique keys", async () => {
    const app = buildApp();
    app.post("/things", async (c) => c.json({ ok: true }));

    // MAX_ENTRIES + 250 distinct keys — an unbounded Map would hold them all.
    for (let i = 0; i < MAX_ENTRIES + 250; i++) {
      await post(app, `unique-key-${i.toString().padStart(6, "0")}`);
    }

    expect(__idempotencyStoreSizeForTests()).toBe(MAX_ENTRIES);
  }, 60_000);

  it("evicts least-recently-USED, not merely oldest-written", async () => {
    const app = buildApp();
    let invocations = 0;
    app.post("/things", async (c) => {
      invocations++;
      return c.json({ ok: true });
    });

    // Fill exactly to the cap. `oldest` is the first key written.
    const oldest = "unique-key-000000";
    for (let i = 0; i < MAX_ENTRIES; i++) {
      await post(app, `unique-key-${i.toString().padStart(6, "0")}`);
    }
    expect(invocations).toBe(MAX_ENTRIES);

    // Replay it — a cache HIT, which must also mark it as most-recently used.
    const replay = await post(app, oldest);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(invocations).toBe(MAX_ENTRIES); // handler did NOT run again

    // Push the cap over with fresh keys. A FIFO would drop `oldest` first;
    // an LRU drops the keys that were never touched again.
    for (let i = 0; i < 100; i++) {
      await post(app, `overflow-key-${i.toString().padStart(6, "0")}`);
    }
    expect(__idempotencyStoreSizeForTests()).toBe(MAX_ENTRIES);

    // Still a hit → it survived eviction because it was recently used.
    const stillCached = await post(app, oldest);
    expect(stillCached.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(invocations).toBe(MAX_ENTRIES + 100);
  }, 60_000);

  it("still serves a within-call retry — the benefit the bound must not cost", async () => {
    const app = buildApp();
    let invocations = 0;
    app.post("/things", async (c) => {
      invocations++;
      return c.json({ id: invocations });
    });

    const key = "retry-key-0001";
    const first = await post(app, key);
    const retry = await post(app, key);

    expect(invocations).toBe(1);
    expect(retry.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await retry.json()).toEqual(await first.json());
  });
});
