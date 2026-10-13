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
 */

import { Hono, type MiddlewareHandler } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

// The limiter is built at import from the env; a small budget keeps the
// test fast. Same prime-then-import shape as the calendar-feed guard.
const BUDGET = 5;
let rateLimitMiddleware: MiddlewareHandler;

let n = 0;
/** A fresh session per test: the limiter's store is module-level. */
const nextSession = () =>
  `ory_kratos_session=session-value-${(n += 1)}-0123456789abcdef`;

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

describe("crud budget — one per signed-in person, not one per address", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    const previous = process.env.RATE_LIMIT_CRUD_MAX;
    process.env.RATE_LIMIT_CRUD_MAX = String(BUDGET);
    ({ rateLimitMiddleware } = await import("./security.js"));
    if (previous === undefined) delete process.env.RATE_LIMIT_CRUD_MAX;
    else process.env.RATE_LIMIT_CRUD_MAX = previous;
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
    for (let i = 0; i <= BUDGET; i += 1) {
      if ((await call(app, "/trpc/public.thing")).status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});
