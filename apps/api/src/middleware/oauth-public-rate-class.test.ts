/**
 * BEHAVIOURAL guard: the pod authorization server's public doors are budgeted
 * per IP (`oauth_public`, spec 17 T11).
 *
 * `/register` writes a row and `/authorize` may make the pod fetch a stranger's
 * metadata document (CIMD), and none of the three takes a credential. In the
 * Bearer-keyed `crud` class a caller sending a made-up Bearer per request got a
 * fresh budget every request. Driven through the real `rateLimitMiddleware`
 * with a NEW random Bearer on every request from one IP.
 *
 * Negative control: drop the `oauth_public` branch in `classifyRateLimitPath`
 * (falls back to `crud`, Bearer-keyed) — the classification cases and
 * "varying Bearers from one IP" go red.
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  classifyRateLimitPath,
  getOAuthPublicRateConfig,
} from "./rate-limit-classes.js";

let rateLimitMiddleware: (typeof import("./security.js"))["rateLimitMiddleware"];
let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimitMiddleware);
  app.post("/register", (c) => c.json({ client_id: "dcr_x" }, 201));
  app.get("/authorize", (c) => c.text("ok"));
  app.post("/token", (c) => c.json({ error: "invalid_grant" }, 400));
  return app;
}

const call = (app: Hono, path: string, ip: string) =>
  app.request(path, {
    method: path === "/authorize" ? "GET" : "POST",
    headers: {
      "x-forwarded-for": ip,
      authorization: `Bearer synap_hub_live_${randomBytes(24).toString("hex")}`,
    },
  });

describe("oauth_public — one IP gets one budget across the AS doors", () => {
  const cfg = getOAuthPublicRateConfig();

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    ({ rateLimitMiddleware } = await import("./security.js"));
  });

  it("classifies /register, /authorize and /token as oauth_public, whatever the method", () => {
    expect(classifyRateLimitPath("/register", "POST")).toBe("oauth_public");
    expect(classifyRateLimitPath("/authorize", "GET")).toBe("oauth_public");
    expect(classifyRateLimitPath("/token", "POST")).toBe("oauth_public");
    expect(classifyRateLimitPath("/authorize?client_id=x", "GET")).toBe(
      "oauth_public"
    );
  });

  it("leaves /revoke, the metadata documents and look-alike paths alone", () => {
    expect(classifyRateLimitPath("/revoke", "POST")).toBe("crud");
    expect(
      classifyRateLimitPath("/.well-known/oauth-authorization-server")
    ).toBe("crud");
    expect(classifyRateLimitPath("/api/hub/token", "POST")).toBe("crud");
    expect(classifyRateLimitPath("/register/x", "POST")).toBe("crud");
  });

  it("defaults to 60 per 10 minutes (finite, non-vacuous)", () => {
    expect(cfg).toMatchObject({ max: 60, windowMs: 600_000 });
  });

  it("429s a caller varying the Bearer every request from one IP, across all three doors", async () => {
    const app = makeApp();
    const ip = nextIp();
    const doors = ["/register", "/authorize", "/token"];
    const statuses: number[] = [];
    for (let i = 0; i < cfg.max + 3; i++)
      statuses.push((await call(app, doors[i % 3]!, ip)).status);
    expect(statuses.slice(0, cfg.max).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(cfg.max)).toEqual([429, 429, 429]);
  });

  it("the 429 names the class", async () => {
    const app = makeApp();
    const ip = nextIp();
    for (let i = 0; i < cfg.max; i++) await call(app, "/token", ip);
    const res = await call(app, "/token", ip);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { class: string }).class).toBe(
      "oauth_public"
    );
  });

  it("another IP keeps its own budget", async () => {
    const app = makeApp();
    const ip = nextIp();
    for (let i = 0; i < cfg.max + 1; i++) await call(app, "/register", ip);
    expect((await call(app, "/register", nextIp())).status).toBe(201);
  });
});
