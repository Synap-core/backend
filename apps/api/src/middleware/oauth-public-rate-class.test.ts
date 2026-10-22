/**
 * BEHAVIOURAL guard: the pod authorization server's public doors are budgeted
 * per IP (`oauth_public`, spec 17 T11), and `/token` per grant
 * (`oauth_token`, review A2).
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
 *
 * On a tunnelled pod (`SYNAP_SHARED_CLIENT_IP`) every caller has the same
 * address, so one IP bucket for `/token` was the whole internet's: 60 cheap
 * `/register` calls blocked every pod app's refresh. `/token` now spends a
 * bucket per (client_id, code or refresh token), under an IP ceiling only
 * where addresses tell callers apart.
 */
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildOAuthTokenKey,
  classifyRateLimitPath,
  getOAuthPublicRateConfig,
  getOAuthTokenRateConfig,
} from "./rate-limit-classes.js";

let rateLimitMiddleware: (typeof import("./security.js"))["rateLimitMiddleware"];
let ipCounter = 0;
const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimitMiddleware);
  app.post("/register", (c) => c.json({ client_id: "dcr_x" }, 201));
  app.get("/authorize", (c) => c.text("ok"));
  // Echoes what /token itself reads: the limiter read the body first.
  app.post("/token", async (c) => {
    const body = new URLSearchParams(await c.req.text());
    return c.json(
      { error: "invalid_grant", client_id: body.get("client_id") },
      400
    );
  });
  return app;
}

const refreshCall = (
  app: Hono,
  ip: string,
  refreshToken: string,
  clientId = "https://studio.example.com/.well-known/synap-client.json"
) => {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  }).toString();
  return app.request("/token", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": "application/x-www-form-urlencoded",
      // What an HTTP client sends with a string body. `new Request` does not
      // set it, and the limiter reads only a body whose length it is told.
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });
};

const randomToken = () => randomBytes(32).toString("base64url");

/** A /token body sent with no length: the limiter does not read it. */
const unreadCall = (app: Hono, ip: string) =>
  app.request("/token", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: randomToken(),
    }).toString(),
  });

/** Runs `run` as a pod whose visitors all share one address (a tunnel). */
async function onSharedAddress<T>(run: () => Promise<T>): Promise<T> {
  process.env.SYNAP_SHARED_CLIENT_IP = "true";
  try {
    return await run();
  } finally {
    delete process.env.SYNAP_SHARED_CLIENT_IP;
  }
}

const call = (app: Hono, path: string, ip: string) =>
  app.request(path, {
    method: path.startsWith("/authorize") ? "GET" : "POST",
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

  it("classifies /register and /authorize as oauth_public, /token as oauth_token, whatever the method", () => {
    expect(classifyRateLimitPath("/register", "POST")).toBe("oauth_public");
    expect(classifyRateLimitPath("/authorize", "GET")).toBe("oauth_public");
    expect(classifyRateLimitPath("/token", "POST")).toBe("oauth_token");
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

  it("429s a caller varying the Bearer every request from one IP, across both doors", async () => {
    const app = makeApp();
    const ip = nextIp();
    const doors = ["/register", "/authorize"];
    const statuses: number[] = [];
    for (let i = 0; i < cfg.max + 2; i++)
      statuses.push((await call(app, doors[i % 2]!, ip)).status);
    expect(statuses.slice(0, cfg.max).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(cfg.max)).toEqual([429, 429]);
  });

  it("the 429 names the class", async () => {
    const app = makeApp();
    const ip = nextIp();
    for (let i = 0; i < cfg.max; i++) await call(app, "/register", ip);
    const res = await call(app, "/register", ip);
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

describe("oauth_token — /token is budgeted per grant, never per shared address (review A2)", () => {
  const cfg = getOAuthPublicRateConfig();
  const tokenCfg = getOAuthTokenRateConfig();

  beforeAll(async () => {
    process.env.DATABASE_URL ??=
      "postgresql://synap:test@localhost:5432/synap_test";
    ({ rateLimitMiddleware } = await import("./security.js"));
  });

  it("defaults to 20 per grant and 600 per IP per 10 minutes", () => {
    expect(tokenCfg).toMatchObject({
      max: 20,
      ipCeiling: 600,
      windowMs: 600_000,
    });
  });

  it("on a shared address, a /register flood does not block any pod app's refresh", async () => {
    await onSharedAddress(async () => {
      const app = makeApp();
      const ip = nextIp();
      for (let i = 0; i < cfg.max; i++) await call(app, "/register", ip);
      expect((await call(app, "/register", ip)).status).toBe(429);
      for (let i = 0; i < 5; i++) {
        expect((await refreshCall(app, ip, randomToken())).status).toBe(400);
      }
    });
  });

  it("on a shared address, a /register flood does not block /authorize, which is budgeted per client_id", async () => {
    await onSharedAddress(async () => {
      const app = makeApp();
      const ip = nextIp();
      for (let i = 0; i < cfg.max + 1; i++) await call(app, "/register", ip);
      const authorize = (clientId: string) =>
        call(app, `/authorize?client_id=${encodeURIComponent(clientId)}`, ip);
      const studio = "https://studio.example.com/.well-known/synap-client.json";
      expect((await authorize(studio)).status).toBe(200);
      // One app's id flooded blocks that app's sign-ins only.
      for (let i = 0; i < cfg.max; i++) await authorize(studio);
      expect((await authorize(studio)).status).toBe(429);
      expect(
        (await authorize("https://notes.example.com/.well-known/c.json")).status
      ).toBe(200);
    });
  });

  it("one grant gets its own bucket: the 21st try of one refresh token is 429, another token is not", async () => {
    const app = makeApp();
    const ip = nextIp();
    const rt = randomToken();
    for (let i = 0; i < tokenCfg.max; i++) {
      expect((await refreshCall(app, ip, rt)).status).toBe(400);
    }
    const res = await refreshCall(app, ip, rt);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { class: string }).class).toBe("oauth_token");
    expect((await refreshCall(app, ip, randomToken())).status).toBe(400);
  });

  it("where addresses are distinct, one IP inventing a grant per request is bounded by the IP ceiling", async () => {
    const app = makeApp();
    const ip = nextIp();
    for (let i = 0; i < tokenCfg.ipCeiling; i++) {
      expect((await refreshCall(app, ip, randomToken())).status).toBe(400);
    }
    expect((await refreshCall(app, ip, randomToken())).status).toBe(429);
    expect((await refreshCall(app, nextIp(), randomToken())).status).toBe(400);
  });

  it("on a shared address there is no IP ceiling: past 600 distinct grants nothing is 429", async () => {
    await onSharedAddress(async () => {
      const app = makeApp();
      const ip = nextIp();
      for (let i = 0; i < tokenCfg.ipCeiling + 5; i++) {
        expect((await refreshCall(app, ip, randomToken())).status).toBe(400);
      }
    });
  });

  it("/token still reads the body the limiter read", async () => {
    const app = makeApp();
    const res = await refreshCall(
      app,
      nextIp(),
      randomToken(),
      "https://a.example/c.json"
    );
    expect(((await res.json()) as { client_id: string }).client_id).toBe(
      "https://a.example/c.json"
    );
  });

  it("where addresses are distinct, an unread body spends its address's own unread bucket", async () => {
    const app = makeApp();
    const ip = nextIp();
    for (let i = 0; i < tokenCfg.max; i++) {
      expect((await unreadCall(app, ip)).status).toBe(400);
    }
    expect((await unreadCall(app, ip)).status).toBe(429);
    expect((await unreadCall(app, nextIp())).status).toBe(400);
  });

  it("on a shared address, every unread body spends the pod's one unread bucket", async () => {
    await onSharedAddress(async () => {
      const app = makeApp();
      for (let i = 0; i < tokenCfg.max; i++) {
        expect((await unreadCall(app, nextIp())).status).toBe(400);
      }
      expect((await unreadCall(app, nextIp())).status).toBe(429);
    });
  });

  it("the key: per (client_id, grant), form or JSON alike, and never the raw token", () => {
    const rt = randomToken();
    const form = (p: Record<string, string>) =>
      buildOAuthTokenKey(
        new URLSearchParams(p).toString(),
        "application/x-www-form-urlencoded"
      );
    const refresh = (token: string, client = "https://a.example/c.json") =>
      form({
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: client,
      });
    expect(refresh(rt)).toBe(refresh(rt));
    expect(refresh(rt)).not.toBe(refresh(randomToken()));
    expect(refresh(rt)).not.toBe(refresh(rt, "https://b.example/c.json"));
    expect(refresh(rt)).not.toContain(rt);
    expect(
      buildOAuthTokenKey(
        JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: rt,
          client_id: "https://a.example/c.json",
        }),
        "application/json"
      )
    ).toBe(refresh(rt));
    const code = randomToken();
    expect(
      form({ grant_type: "authorization_code", code, client_id: "dcr_x" })
    ).not.toContain(code);
    expect(buildOAuthTokenKey(null, "")).toBe("oauth_token:unread");
    expect(buildOAuthTokenKey("{not json", "application/json")).toBe(
      "oauth_token:unread"
    );
    expect(buildOAuthTokenKey("null", "application/json")).toBe(
      "oauth_token:unread"
    );
    // The unread bucket: per address where addresses tell callers apart.
    expect(buildOAuthTokenKey(null, "", "198.51.100.7", {})).toBe(
      "oauth_token:unread:198.51.100.7"
    );
    expect(
      buildOAuthTokenKey("{not json", "application/json", "198.51.100.7", {})
    ).toBe("oauth_token:unread:198.51.100.7");
    expect(
      buildOAuthTokenKey(null, "", "198.51.100.7", {
        SYNAP_SHARED_CLIENT_IP: "true",
      })
    ).toBe("oauth_token:unread");
    expect(buildOAuthTokenKey(null, "", "unknown", {})).toBe(
      "oauth_token:unread"
    );
  });
});
