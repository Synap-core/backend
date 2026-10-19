import { beforeAll, describe, expect, it } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";

let httpCacheHeadersMiddleware: MiddlewareHandler;
beforeAll(async () => {
  // pod-edge-cors pulls the config, which needs a database URL to load.
  process.env.DATABASE_URL ??=
    "postgresql://synap:test@localhost:5432/synap_test";
  ({ httpCacheHeadersMiddleware } = await import("./pod-edge-cors.js"));
}, 120_000);

/**
 * Pod reads are live data. A tRPC query is a GET, so an HTTP-cacheable GET
 * default let a read right after a write come back from the cache with the
 * pre-write body (2026-10-19: a kept note read as "not saved yet").
 */
function app() {
  const a = new Hono();
  a.use("*", httpCacheHeadersMiddleware);
  a.get("/trpc/onboarding.getJourney", (c) => c.json({ ok: true }));
  a.get("/asset", (c) => {
    c.header("Cache-Control", "public, max-age=600, immutable");
    return c.text("x");
  });
  a.post("/trpc/onboarding.recordValues", (c) => c.json({ ok: true }));
  return a;
}

describe("httpCacheHeadersMiddleware", () => {
  it("a GET without its own Cache-Control is never HTTP-cached", async () => {
    const res = await app().request("/trpc/onboarding.getJourney");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("a route that sets its own Cache-Control keeps it", async () => {
    const res = await app().request("/asset");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=600, immutable"
    );
  });

  it("writes are never cached", async () => {
    const res = await app().request("/trpc/onboarding.recordValues", {
      method: "POST",
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
