/**
 * BEHAVIOURAL guard for the calendar-feed IP ceiling.
 *
 * The defect this pins actually shipped: `/calendar/feed/{token}.ics` is the
 * pod's only unauthenticated endpoint whose rate-limit bucket is keyed on a
 * path segment the CALLER chooses. Keyed on the token alone, a fresh random
 * token per request buys a fresh budget every request — so the endpoint that
 * looked rate-limited had no throttle at all, and every attempted token stayed
 * in the limiter's in-process map for two windows.
 *
 * A shape test cannot catch that: `classifyRateLimitPath` and
 * `buildRateLimitKey` were both individually correct. Only DRIVING the
 * middleware with varying tokens from one IP shows it. So this test makes real
 * requests through the real `rateLimitMiddleware`.
 *
 * Negative control (re-run when touching this): in `security.ts`, change the
 * `calendar_feed` case back to `return calendarFeedRateLimiter(c, next)` —
 * "varying tokens from one IP" must go RED while "one token, one IP" stays
 * green. Verified when this was written.
 *
 * NOT covered, measured: the limiter is constructed at module import from
 * `getCalendarFeedIpCeiling()`, so this drives the DEFAULT ceiling (600/5min).
 * It does not prove the env override is read — `getCalendarFeedIpCeiling` has
 * its own unit assertion below for that.
 */

import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

import { getCalendarFeedIpCeiling } from "./rate-limit-classes.js";

// `security.ts` pulls the shared config package (via getDynamicCorsOrigins),
// which refuses to load without a database URL. Same prime-then-import shape
// as `routers/provision-deprecations.test.ts` — this test never touches the
// database, it just needs the module to finish importing.
let rateLimitMiddleware: (typeof import("./security.js"))["rateLimitMiddleware"];

/**
 * A FRESH IP per test. The limiter's store is module-level and shared across
 * every test in this file (and it has no reset door), so a reused IP means the
 * second test inherits the first one's exhausted budget — which is exactly how
 * the "a real client is never limited" case first went red against a working
 * limiter.
 */
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter += 1)}`;

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimitMiddleware);
  app.get("/api/hub/calendar/feed/:token", (c) => c.text("BEGIN:VCALENDAR"));
  return app;
}

/** One request with a caller-chosen token, from a chosen IP. */
async function poll(app: Hono, token: string, ip: string) {
  return app.request(`/api/hub/calendar/feed/${token}.ics`, {
    headers: { "x-forwarded-for": ip },
  });
}

describe("calendar feed — the IP ceiling bounds an anonymous caller", () => {
  const ceiling = getCalendarFeedIpCeiling();

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    ({ rateLimitMiddleware } = await import("./security.js"));
  });

  it("has a ceiling that is generous but finite (non-vacuity)", () => {
    // If this were Infinity or 0 the traffic assertions below would pass or
    // fail for reasons that have nothing to do with the limiter.
    expect(ceiling.max).toBeGreaterThan(100);
    expect(ceiling.max).toBeLessThan(100_000);
  });

  it("429s a caller who varies the token every request from one IP", async () => {
    const app = makeApp();
    const ip = nextIp();
    let sawLimit = false;
    // One over the ceiling is enough; the whole point is that this used to be
    // unbounded no matter how many requests were sent.
    for (let i = 0; i <= ceiling.max; i += 1) {
      const res = await poll(app, `attacker-token-${i}`, ip);
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  it("does not punish a second household — the ceiling is per IP", async () => {
    const app = makeApp();
    const noisy = nextIp();
    const quiet = nextIp();
    for (let i = 0; i <= ceiling.max; i += 1) {
      await poll(app, `attacker-token-${i}`, noisy);
    }
    // The first IP is now limited; a different IP must still be served.
    expect((await poll(app, "noisy-is-limited", noisy)).status).toBe(429);
    expect((await poll(app, "neighbour-token", quiet)).status).toBe(200);
  });

  it("a real subscribed client polling one token is never limited", async () => {
    const app = makeApp();
    const ip = nextIp();
    // Apple polls ~every 15 min: a few hundred polls is many days of use, and
    // stays under BOTH the per-token bucket and the IP ceiling.
    for (let i = 0; i < 100; i += 1) {
      const res = await poll(app, "a-real-minted-token", ip);
      expect(res.status).toBe(200);
    }
  });
});
