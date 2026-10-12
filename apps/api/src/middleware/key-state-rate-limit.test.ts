/**
 * BEHAVIOURAL guard: `/auth/key-state` is budgeted per IP.
 *
 * The route skips auth (it answers a key that does NOT authenticate), so the
 * global `crud` class — keyed on the Bearer hash — gave a caller who sends a
 * made-up Bearer per request a fresh budget every request: no throttle at
 * all on an endpoint that runs a key lookup (and, for a legacy prefix, a
 * bcrypt compare). Driven through the real `rateLimitMiddleware` with a NEW
 * random Bearer on every request from one IP.
 *
 * Negative control: drop the `key_state` branch in `classifyRateLimitPath`
 * (falls back to `crud`, Bearer-keyed) — "varying Bearers from one IP" goes
 * red. NOT covered: the env overrides (unit-asserted below via the config).
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  classifyRateLimitPath,
  getKeyStateRateConfig,
} from "./rate-limit-classes.js";

let rateLimitMiddleware: (typeof import("./security.js"))["rateLimitMiddleware"];
let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimitMiddleware);
  app.get("/api/hub/auth/key-state", (c) => c.json({ state: "unknown" }));
  return app;
}

const ask = (app: Hono, ip: string) =>
  app.request("/api/hub/auth/key-state", {
    headers: {
      "x-forwarded-for": ip,
      authorization: `Bearer synap_hub_live_${randomBytes(24).toString("hex")}`,
    },
  });

describe("key-state — one IP gets one budget, whatever Bearer it sends", () => {
  const cfg = getKeyStateRateConfig();

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    ({ rateLimitMiddleware } = await import("./security.js"));
  });

  it("classifies both hub mounts as key_state, and nothing else", () => {
    expect(classifyRateLimitPath("/api/hub/auth/key-state")).toBe("key_state");
    expect(classifyRateLimitPath("/api/hub-protocol/auth/key-state")).toBe(
      "key_state"
    );
    expect(classifyRateLimitPath("/api/hub/auth/status")).toBe("crud");
  });

  it("defaults to 30 per 10 minutes (finite, non-vacuous)", () => {
    expect(cfg).toMatchObject({ max: 30, windowMs: 600_000 });
  });

  it("429s a caller varying the Bearer every request from one IP", async () => {
    const app = makeApp();
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < cfg.max + 3; i++)
      statuses.push((await ask(app, ip)).status);
    expect(statuses.slice(0, cfg.max).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(cfg.max)).toEqual([429, 429, 429]);
  });

  it("another IP keeps its own budget", async () => {
    const app = makeApp();
    for (let i = 0; i < cfg.max + 1; i++) await ask(app, nextIp());
    expect((await ask(app, nextIp())).status).toBe(200);
  });
});
