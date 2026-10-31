/**
 * BEHAVIOURAL guard: every rate-limit 429 says how long to wait (`Retry-After`, delta-seconds).
 *
 * A pod app's server (Content Studio, the CRM) reads `Retry-After` to tell the person how long ("Try again in 12
 * minutes"); without it the app can only guess. The per-key `crud` buckets (the ones a pod app spends) always sent it
 * (`standardHeaders: "draft-7"`), but the address-wide ceilings (`crud`, `calendar_feed`, `oauth_token`) run with
 * `standardHeaders: false` and answered a bare 429. Each case below DRIVES the real
 * `rateLimitMiddleware` past the limit, with the limits made small through their env variables (read when
 * `security.ts` is imported, so they are set before the import; vitest runs each file in its own module graph).
 *
 * Negative control (re-run when touching this): in `security.ts`, give `crudIpCeilingLimiter` `classHandler` instead of
 * `retryAfterHandler` again: "the crud address ceiling" goes RED, "one key's own bucket" stays green.
 */
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

let rateLimitMiddleware: (typeof import("./security.js"))["rateLimitMiddleware"];

const CRUD_MAX = 5;
const CRUD_CEILING = 12;
const CALENDAR_IP_MAX = 6;
const TOKEN_CEILING = 6;

let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimitMiddleware);
  app.get("/api/hub/entities", (c) => c.json([]));
  app.post("/api/hub/entities", (c) => c.json({ ok: true }));
  app.get("/api/hub/calendar/feed/:token", (c) => c.text("BEGIN:VCALENDAR"));
  app.post("/token", (c) => c.json({ error: "invalid_grant" }, 400));
  return app;
}

/** Sends `request(i)` until the first 429 (at most `max` + 1 times) and returns it, or null. */
async function firstLimited(
  send: (i: number) => Promise<Response>,
  max: number
): Promise<Response | null> {
  for (let i = 0; i <= max; i += 1) {
    const res = await send(i);
    if (res.status === 429) return res;
  }
  return null;
}

/** A Retry-After a client can use: whole seconds, at least 1, at most the window. */
function expectUsableRetryAfter(res: Response | null, windowSec: number) {
  expect(res?.status).toBe(429);
  const header = res!.headers.get("retry-after");
  expect(header, "the 429 says how long to wait").toMatch(/^\d+$/);
  expect(Number(header)).toBeGreaterThanOrEqual(1);
  expect(Number(header)).toBeLessThanOrEqual(windowSec);
}

beforeAll(async () => {
  process.env.DATABASE_URL ??=
    "postgresql://synap:test@localhost:5432/synap_test";
  process.env.RATE_LIMIT_CRUD_MAX = String(CRUD_MAX);
  process.env.RATE_LIMIT_CRUD_IP_CEILING = String(CRUD_CEILING);
  process.env.RATE_LIMIT_CALENDAR_FEED_IP_MAX = String(CALENDAR_IP_MAX);
  process.env.RATE_LIMIT_OAUTH_TOKEN_IP_CEILING = String(TOKEN_CEILING);
  ({ rateLimitMiddleware } = await import("./security.js"));
});

describe("every rate-limit 429 carries Retry-After", () => {
  it("one key's own crud write bucket (what a pod app spends): Retry-After and its RateLimit numbers", async () => {
    const app = makeApp();
    const ip = nextIp();
    const bearer = `Bearer synap_hub_live_${"a".repeat(40)}`;
    const res = await firstLimited(
      (): Promise<Response> =>
        Promise.resolve(
          app.request("/api/hub/entities", {
            method: "POST",
            headers: {
              authorization: bearer,
              "content-type": "application/json",
              "x-forwarded-for": ip,
            },
            body: "{}",
          })
        ),
      CRUD_MAX
    );
    expectUsableRetryAfter(res, 900);
    expect(res!.headers.get("ratelimit")).toMatch(
      new RegExp(`^limit=${CRUD_MAX}, remaining=0, reset=\\d+$`)
    );
  });

  it("the crud address ceiling (a key per request from one address)", async () => {
    const app = makeApp();
    const ip = nextIp();
    const res = await firstLimited(
      (i): Promise<Response> =>
        Promise.resolve(
          app.request("/api/hub/entities", {
            headers: {
              authorization: `Bearer synap_hub_live_${String(i).padStart(40, "k")}`,
              "x-forwarded-for": ip,
            },
          })
        ),
      CRUD_CEILING
    );
    expectUsableRetryAfter(res, 900);
    // The ceiling's 429, not a per-key one: each key above was used once.
    expect(await res!.json()).toMatchObject({
      class: "crud",
      limit: CRUD_CEILING,
    });
  });

  it("the calendar feed's address ceiling (a token per request)", async () => {
    const app = makeApp();
    const ip = nextIp();
    const res = await firstLimited(
      (i): Promise<Response> =>
        Promise.resolve(
          app.request(`/api/hub/calendar/feed/t${i}.ics`, {
            headers: { "x-forwarded-for": ip },
          })
        ),
      CALENDAR_IP_MAX
    );
    expectUsableRetryAfter(res, 300);
  });

  it("the token endpoint's address ceiling (a grant per request)", async () => {
    const app = makeApp();
    const ip = nextIp();
    const res = await firstLimited(
      (i): Promise<Response> =>
        Promise.resolve(
          app.request("/token", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-forwarded-for": ip,
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: "https://app.example.com/c.json",
              refresh_token: `r${i}`,
            }).toString(),
          })
        ),
      TOKEN_CEILING
    );
    expectUsableRetryAfter(res, 600);
  });
});
