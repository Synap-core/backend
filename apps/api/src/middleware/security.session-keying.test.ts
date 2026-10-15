/**
 * BEHAVIOURAL guard for per-session keying of the `crud` budget.
 *
 * The defect this pins: pod-admin's server-side calls (whoami + the
 * `sync.getStatus` admin probe on every page request, its API routes) reach
 * `backend:4000` with no X-Forwarded-For. `clientIp` answers "unknown" and,
 * keyed by IP, every operator on the pod spent ONE `crud:ip:unknown` budget —
 * one busy console 429'd everyone's gate checks. `buildRateLimitKey` unit
 * tests cannot show that; driving the real middleware can.
 *
 * Negative control (re-run when touching this): drop the `cookieHeader`
 * argument from the `buildRateLimitKey` call in `security.ts` — "a second
 * person keeps their budget" must go RED.
 *
 * Also pinned: the address-wide ceiling (`crud:ipall:*`) in front of those
 * buckets — invented sessions from one address stop at it, a real session
 * from its own address still gets its whole budget, and a pod whose visitors
 * share one address has no ceiling; and a forwarding header saying
 * "127.0.0.1" no longer buys the loopback bypass.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

// The limiter is built at import from the env; a small budget keeps the
// test fast. Same prime-then-import shape as the calendar-feed guard.
const BUDGET = 5;
const ANON_BUDGET = 3;
const IP_CEILING = 8;
let rateLimitMiddleware: MiddlewareHandler;

let n = 0;
/**
 * A fresh session per test: the limiter's store is module-level. Real-cookie
 * length (Kratos's securecookie is a few hundred characters; the key needs 64).
 */
const nextSession = () =>
  `ory_kratos_session=${`session-value-${(n += 1)}-`.padEnd(120, "0123456789abcdef")}`;
/** A fresh client address per test, for the same reason. */
const nextIp = () => `203.0.113.${(n += 1) % 250}`;

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimitMiddleware);
  app.get("/trpc/*", (c) => c.json({ ok: true }));
  app.get("/.ory/kratos/public/*", (c) => c.json({ ok: true }));
  return app;
}

/** A server-side call: no X-Forwarded-For, so the IP reads "unknown". */
const call = (app: Hono, path: string, cookie?: string) =>
  app.request(path, { headers: cookie ? { cookie } : {} });

/** A call relayed by Caddy (or pod-admin): the client's address is known. */
const callFrom = (app: Hono, ip: string, cookie?: string) =>
  app.request("/trpc/sync.getStatus", {
    headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
  });

describe("crud budget — one per signed-in person, not one per address", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    const budgets = {
      RATE_LIMIT_CRUD_MAX: String(ANON_BUDGET),
      RATE_LIMIT_CRUD_SESSION_MAX: String(BUDGET),
      RATE_LIMIT_CRUD_IP_CEILING: String(IP_CEILING),
    };
    const previous = Object.fromEntries(
      Object.keys(budgets).map((k) => [k, process.env[k]])
    );
    // Anonymous callers get a smaller budget than a signed-in person, and the
    // address ceiling sits above one person's; the tests spend each in full.
    Object.assign(process.env, budgets);
    ({ rateLimitMiddleware } = await import("./security.js"));
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("a second person keeps their budget after the first spends theirs", async () => {
    const app = makeApp();
    const a = nextSession();
    const b = nextSession();
    for (let i = 0; i < BUDGET; i += 1) {
      expect((await call(app, "/trpc/sync.getStatus", a)).status).toBe(200);
    }
    expect((await call(app, "/trpc/sync.getStatus", a)).status).toBe(429);
    expect((await call(app, "/trpc/sync.getStatus", b)).status).toBe(200);
  });

  it("the Kratos whoami proxy and tRPC spend the same per-session bucket", async () => {
    const app = makeApp();
    const a = nextSession();
    for (let i = 0; i < BUDGET; i += 1) {
      const path =
        i % 2 ? "/trpc/sync.getStatus" : "/.ory/kratos/public/sessions/whoami";
      expect((await call(app, path, a)).status).toBe(200);
    }
    expect(
      (await call(app, "/.ory/kratos/public/sessions/whoami", a)).status
    ).toBe(429);
  });

  it("anonymous callers without an address still share the IP bucket", async () => {
    const app = makeApp();
    let sawLimit = false;
    for (let i = 0; i <= ANON_BUDGET; i += 1) {
      if ((await call(app, "/trpc/public.thing")).status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it("a signed-in person gets the larger session budget, not the anonymous one", async () => {
    const app = makeApp();
    const a = nextSession();
    for (let i = 0; i < BUDGET; i += 1) {
      expect((await call(app, "/trpc/sync.getStatus", a)).status).toBe(200);
    }
    expect(BUDGET).toBeGreaterThan(ANON_BUDGET);
  });

  it("a signed-in person behind a known address still gets their whole budget", async () => {
    const app = makeApp();
    const ip = nextIp();
    const a = nextSession();
    for (let i = 0; i < BUDGET; i += 1) {
      expect((await callFrom(app, ip, a)).status).toBe(200);
    }
    expect((await callFrom(app, ip, a)).status).toBe(429);
  });

  it("invented sessions from one address stop at the address ceiling", async () => {
    const app = makeApp();
    const ip = nextIp();
    for (let i = 0; i < IP_CEILING; i += 1) {
      expect((await callFrom(app, ip, nextSession())).status).toBe(200);
    }
    const res = await callFrom(app, ip, nextSession());
    expect(res.status).toBe(429);
    // Another address is untouched.
    expect((await callFrom(app, nextIp(), nextSession())).status).toBe(200);
  });

  it("a short invented cookie spends the anonymous budget, not a session's", async () => {
    const app = makeApp();
    const ip = nextIp();
    let limitedAt = -1;
    for (let i = 0; i <= ANON_BUDGET; i += 1) {
      const cookie = `ory_kratos_session=invented-${i}-0123456789abcdef`;
      if ((await callFrom(app, ip, cookie)).status === 429) {
        limitedAt = i;
        break;
      }
    }
    expect(limitedAt).toBe(ANON_BUDGET);
  });

  it("has no address ceiling when every visitor shares one address", async () => {
    const app = makeApp();
    const ip = nextIp();
    const prior = process.env.SYNAP_SHARED_CLIENT_IP;
    process.env.SYNAP_SHARED_CLIENT_IP = "true";
    try {
      for (let i = 0; i <= IP_CEILING; i += 1) {
        expect((await callFrom(app, ip, nextSession())).status).toBe(200);
      }
    } finally {
      if (prior === undefined) delete process.env.SYNAP_SHARED_CLIENT_IP;
      else process.env.SYNAP_SHARED_CLIENT_IP = prior;
    }
  });

  it("a forwarding header saying 127.0.0.1 is not the loopback bypass", async () => {
    const app = makeApp();
    let sawLimit = false;
    for (let i = 0; i <= ANON_BUDGET; i += 1) {
      if ((await callFrom(app, "127.0.0.1")).status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});
