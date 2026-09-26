/**
 * TRIPWIRE — the credentialless public doors (`/api/hub/public/*`, Sites W3).
 *
 * Drives the REAL pod-edge chain in `index.ts` order —
 *   publicDoorTransport → podEdgeCorsMiddleware → requestSizeLimit →
 *   rateLimitMiddleware → secureHeaders → httpCacheHeadersMiddleware → route
 * — with stand-in ROUTES only (the real read route has its own PGlite tripwire:
 * packages/api `rest/public-shares.tripwire.test.ts`).
 *
 * Pins:
 *   1. Never `Access-Control-Allow-Credentials`, never a reflected Origin
 *      (`*`), only `Content-Type` allowed, GET/POST/OPTIONS, preflight 204 —
 *      for a foreign, a first-party, a `null` and no Origin, and even when a
 *      handler downstream sets the credentials header itself.
 *   2. Authorization / Cookie / X-Session-Token never change the bytes.
 *   3. A random Bearer per request cannot mint a fresh rate bucket (read: IP
 *      ceiling; submit: IP ceiling, then per-share bucket).
 *   4. `Cache-Control: no-cache` on reads (never the global max-age=60).
 *   5. 16 KB body ceiling on the STREAM (a chunked body with no length).
 *   6. The legacy `/public/projection` and every normal API keep the
 *      credentialed policy (a foreign origin is still 403'd).
 *   7. DERIVED: every route registered under `/public/` in the hub REST source
 *      is covered by the ONE predicate; no source outside the predicate module
 *      and the route files spells a `/public/` literal; every consumer calls the
 *      predicate; `index.ts` mounts the transport FIRST.
 *
 * NOT covered, measured: a real browser's preflight (NEEDS-DOGFOOD); the
 * limiter store is in-process, so these numbers hold per pod process only; the
 * index.ts ORDER check is a source scan (it sees a moved `app.use`, not a
 * wrapper that re-orders at runtime).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { beforeAll, describe, expect, it } from "vitest";

import { isPublicDoorPath } from "@synap/api/public-doors";
import {
  classifyRateLimitPath,
  getPublicDoorRateConfig,
} from "./middleware/rate-limit-classes.js";
import { redactSecretPath } from "./middleware/redact-secret-path.js";
import { publicDoorTransport } from "./public-door-transport.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, "..", "..", "..");
const HUB_REST = path.join(
  BACKEND,
  "packages/api/src/routers/hub-protocol/rest"
);

// `security.ts` + `cors-origin.ts` pull the shared config package, which
// refuses to load without a database URL. Prime-then-import (the calendar
// ceiling test's shape); nothing here queries it on a public path.
let chain: {
  podEdgeCorsMiddleware: MiddlewareHandler;
  httpCacheHeadersMiddleware: MiddlewareHandler;
  requestSizeLimit: MiddlewareHandler;
  rateLimitMiddleware: MiddlewareHandler;
};

const FIRST_PARTY = "https://app.pod.example.test";
const FOREIGN = "https://someone.vercel.app";

beforeAll(async () => {
  process.env.DATABASE_URL ??=
    "postgresql://synap:test@localhost:5432/synap_test";
  process.env.SYNAP_BASE_DOMAIN = "pod.example.test";
  const sec = await import("./middleware/security.js");
  const edge = await import("./pod-edge-cors.js");
  chain = {
    podEdgeCorsMiddleware: edge.podEdgeCorsMiddleware,
    httpCacheHeadersMiddleware: edge.httpCacheHeadersMiddleware,
    requestSizeLimit: sec.requestSizeLimit,
    rateLimitMiddleware: sec.rateLimitMiddleware,
  };
}, 120_000);

function makeApp() {
  const app = new Hono();
  app.use("*", publicDoorTransport);
  app.use("*", chain.podEdgeCorsMiddleware);
  app.use("*", chain.requestSizeLimit);
  app.use("*", chain.rateLimitMiddleware);
  app.use("*", secureHeaders());
  app.use("*", chain.httpCacheHeadersMiddleware);
  // Stand-in routes. The read never looks at a credential (like the real one).
  app.get("/api/hub/public/shares/:token", (c) =>
    c.json({ token: c.req.param("token").length })
  );
  // A ROGUE handler: tries to widen the policy downstream. Must be scrubbed.
  app.get("/api/hub/public/rogue/:token", (c) => {
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Origin", FOREIGN);
    c.header("Access-Control-Allow-Headers", "Authorization, Cookie");
    c.header("Set-Cookie", "leak=1");
    c.header("Cache-Control", "public, max-age=600");
    return c.json({ ok: true });
  });
  app.post("/api/hub/public/forms/:token/submissions", async (c) => {
    const text = await c.req.text();
    return c.json({ received: text.length }, 202);
  });
  app.get("/api/hub/public/projection", (c) => c.json({ items: [] }));
  app.get("/api/hub/entities", (c) => c.json({ items: [] }));
  return app;
}

let ip6Counter = 0;
const nextIp6 = () => `2001:db8::${(ip6Counter += 1).toString(16)}`;

function headerList(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((value, key) => out.push([key, value]));
  return out;
}

const snapshot = async (res: Response) => ({
  status: res.status,
  body: await res.text(),
  headers: headerList(res.headers).sort(([a], [b]) => a.localeCompare(b)),
});

describe("public doors — credentialless CORS", () => {
  const ORIGINS: Array<string | undefined> = [
    FOREIGN,
    FIRST_PARTY,
    "null",
    undefined,
  ];
  const CREDS: Array<Record<string, string>> = [
    {},
    { Authorization: "Bearer " + "x".repeat(40) },
    { Cookie: "ory_kratos_session=abc" },
    { "X-Session-Token": "abc" },
  ];

  it("GET / POST / OPTIONS from any origin: `*`, no credentials header, Content-Type only", async () => {
    const app = makeApp();
    let checked = 0;
    for (const origin of ORIGINS) {
      for (const creds of CREDS) {
        for (const [method, url] of [
          ["GET", "/api/hub/public/shares/tok-1"],
          ["GET", "/api/hub/public/rogue/tok-1"],
          ["POST", "/api/hub/public/forms/tok-1/submissions"],
          ["OPTIONS", "/api/hub/public/shares/tok-1"],
        ] as const) {
          const headers: Record<string, string> = {
            ...creds,
            "x-forwarded-for": nextIp6(),
            ...(origin ? { Origin: origin } : {}),
            ...(method === "OPTIONS"
              ? {
                  "Access-Control-Request-Method": "GET",
                  "Access-Control-Request-Headers": "authorization, cookie",
                }
              : {}),
            ...(method === "POST"
              ? { "Content-Type": "application/json" }
              : {}),
          };
          const res = await app.request(url, {
            method,
            headers,
            ...(method === "POST" ? { body: "{}" } : {}),
          });
          const ctx = `${method} ${url} origin=${origin} creds=${Object.keys(creds)}`;
          expect(
            res.headers.get("access-control-allow-credentials"),
            ctx
          ).toBeNull();
          expect(res.headers.get("access-control-allow-origin"), ctx).toBe("*");
          expect(res.headers.get("access-control-allow-headers"), ctx).toBe(
            "Content-Type"
          );
          expect(res.headers.get("access-control-allow-methods"), ctx).toBe(
            "GET, POST, OPTIONS"
          );
          expect(res.headers.get("set-cookie"), ctx).toBeNull();
          expect([401, 403], ctx).not.toContain(res.status);
          if (method === "OPTIONS") expect(res.status, ctx).toBe(204);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(ORIGINS.length * CREDS.length * 4); // non-vacuity
  });

  it("reads revalidate every time (the global max-age=60 never lands)", async () => {
    const app = makeApp();
    for (const url of [
      "/api/hub/public/shares/tok-2",
      "/api/hub/public/rogue/tok-2",
    ]) {
      const res = await app.request(url, {
        headers: { "x-forwarded-for": nextIp6() },
      });
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("control: a normal API and the legacy projection keep the credentialed policy", async () => {
    const app = makeApp();
    for (const url of ["/api/hub/entities", "/api/hub/public/projection"]) {
      const foreign = await app.request(url, {
        headers: { Origin: FOREIGN, "x-forwarded-for": nextIp6() },
      });
      expect(foreign.status, url).toBe(403);
      const first = await app.request(url, {
        headers: { Origin: FIRST_PARTY, "x-forwarded-for": nextIp6() },
      });
      expect(first.headers.get("access-control-allow-origin"), url).toBe(
        FIRST_PARTY
      );
      expect(first.headers.get("access-control-allow-credentials"), url).toBe(
        "true"
      );
    }
  });
});

describe("public doors — a credential never changes the response", () => {
  it("byte-identical status, body and headers with and without Authorization / Cookie", async () => {
    const app = makeApp();
    for (const url of [
      "/api/hub/public/shares/tok-3",
      "/api/hub/public/nope/tok-3",
    ]) {
      const ip = nextIp6();
      const bare = await snapshot(
        await app.request(url, {
          headers: { Origin: FOREIGN, "x-forwarded-for": ip },
        })
      );
      for (const creds of [
        { Authorization: "Bearer " + "y".repeat(40) },
        { Cookie: "ory_kratos_session=forged" },
        { "X-Session-Token": "forged" },
      ]) {
        const withCreds = await snapshot(
          await app.request(url, {
            headers: { ...creds, Origin: FOREIGN, "x-forwarded-for": ip },
          })
        );
        expect({ url, creds, ...withCreds }).toEqual({ url, creds, ...bare });
      }
    }
  });
});

describe("public doors — rate limits a caller cannot reset", () => {
  const cfg = getPublicDoorRateConfig();

  it("budgets are the approved defaults (non-vacuity for the traffic below)", () => {
    expect(cfg.readIp).toMatchObject({ max: 300, windowMs: 5 * 60 * 1000 });
    expect(cfg.submitIp).toMatchObject({ max: 10, windowMs: 10 * 60 * 1000 });
    expect(cfg.submitShare).toMatchObject({
      max: 200,
      windowMs: 60 * 60 * 1000,
    });
  });

  it("read: a fresh random Bearer per request still hits the one IP ceiling", async () => {
    const app = makeApp();
    const ip = nextIp6();
    let firstLimited = -1;
    for (let i = 0; i <= cfg.readIp.max; i += 1) {
      const res = await app.request(`/api/hub/public/shares/tok-${i}`, {
        headers: {
          Authorization: `Bearer ${crypto.randomUUID()}${crypto.randomUUID()}`,
          "x-forwarded-for": ip,
        },
      });
      if (res.status === 429) {
        firstLimited = i;
        break;
      }
    }
    expect(firstLimited).toBe(cfg.readIp.max);
    // Another IP is untouched: the ceiling is per IP, not global.
    const other = await app.request("/api/hub/public/shares/tok-x", {
      headers: { "x-forwarded-for": nextIp6() },
    });
    expect(other.status).toBe(200);
  });

  it("read: no per-share cap — one share read from many IPs is never limited", async () => {
    const app = makeApp();
    for (let i = 0; i < cfg.readIp.max + 50; i += 1) {
      const res = await app.request("/api/hub/public/shares/viral-page", {
        headers: { "x-forwarded-for": nextIp6() },
      });
      expect(res.status).toBe(200);
    }
  });

  it("submit: a fresh Bearer AND a fresh token per request still hit the IP ceiling", async () => {
    const app = makeApp();
    const ip = nextIp6();
    let firstLimited = -1;
    for (let i = 0; i <= cfg.submitIp.max; i += 1) {
      const res = await app.request(
        `/api/hub/public/forms/${crypto.randomUUID()}/submissions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${crypto.randomUUID()}${crypto.randomUUID()}`,
            "Content-Type": "application/json",
            "x-forwarded-for": ip,
          },
          body: "{}",
        }
      );
      if (res.status === 429) {
        firstLimited = i;
        break;
      }
    }
    expect(firstLimited).toBe(cfg.submitIp.max);
  });

  it("submit: one share is capped across many IPs; another share is not", async () => {
    const app = makeApp();
    const submit = (token: string, ip: string) =>
      app.request(`/api/hub/public/forms/${token}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: "{}",
      });
    let firstLimited = -1;
    for (let i = 0; i <= cfg.submitShare.max; i += 1) {
      const res = await submit("one-form", nextIp6());
      if (res.status === 429) {
        firstLimited = i;
        break;
      }
    }
    expect(firstLimited).toBe(cfg.submitShare.max);
    expect((await submit("another-form", nextIp6())).status).toBe(202);
  });
});

describe("public doors — body ceiling on the stream", () => {
  it("a chunked 17 KB body with no Content-Length is refused with 413", async () => {
    const app = makeApp();
    const chunk = new TextEncoder().encode("a".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 17) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const res = await app.request("/api/hub/public/forms/tok-big/submissions", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "x-forwarded-for": nextIp6() },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("control: a 15 KB body passes", async () => {
    const app = makeApp();
    const res = await app.request("/api/hub/public/forms/tok-ok/submissions", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "x-forwarded-for": nextIp6() },
      body: "a".repeat(15 * 1024),
    });
    expect(res.status).toBe(202);
  });
});

// ── DERIVED: the namespace is the contract ────────────────────────────────

/** A Hono route registration whose path literal starts with `/public/`. */
const ROUTE_RE =
  /\bapp\.(get|post|put|patch|delete|all)\(\s*["'`](\/public\/[^"'`]*)["'`]/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed: block comments, and whole lines that are a
 * `//` or JSDoc `*` continuation. A trailing `// …` after code is KEPT (a
 * string may contain `//`), so a literal in a trailing comment still counts —
 * the conservative direction.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

const isTest = (f: string) =>
  /\.test\.tsx?$/.test(f) || f.includes("__tests__");

describe("public doors — every route under the prefix is covered by the ONE predicate", () => {
  it("self-check: the registration scan sees a literal sample", () => {
    const sample = `app.post("/public/forms/:token/submissions", h)`;
    expect([...sample.matchAll(ROUTE_RE)].map((m) => m[2])).toEqual([
      "/public/forms/:token/submissions",
    ]);
  });

  it("each registered public route is a public door at both mounts, redacted in logs and in a public rate class", () => {
    const files = walk(HUB_REST).filter((f) => !isTest(f));
    expect(files.length).toBeGreaterThan(40); // the scan read the real router
    const routes: Array<{ method: string; route: string; file: string }> = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(ROUTE_RE)) {
        routes.push({ method: m[1]!, route: m[2]!, file: path.basename(file) });
      }
    }
    const doors = routes.filter((r) => r.route !== "/public/projection");
    // Non-vacuity: the legacy projection and at least the share read exist.
    expect(routes.some((r) => r.route === "/public/projection")).toBe(true);
    expect(doors.some((r) => r.route === "/public/shares/:token")).toBe(true);
    for (const { method, route, file } of doors) {
      const concrete = route.replace(/:[A-Za-z_]+/g, "sample-capability-123");
      for (const mount of ["/api/hub", "/api/hub-protocol"]) {
        const full = mount + concrete;
        expect(isPublicDoorPath(full), `${file} ${route}`).toBe(true);
        expect(
          classifyRateLimitPath(full, method.toUpperCase()),
          route
        ).toMatch(/^public_(read|submit)$/);
        if (route.includes(":")) {
          expect(redactSecretPath(full), route).not.toContain(
            "sample-capability-123"
          );
        }
      }
    }
  });

  it("the legacy projection stays OUTSIDE the contract", () => {
    for (const mount of ["/api/hub", "/api/hub-protocol"]) {
      expect(isPublicDoorPath(`${mount}/public/projection`)).toBe(false);
      expect(classifyRateLimitPath(`${mount}/public/projection`)).toBe("crud");
    }
  });

  it("ambiguous paths fail closed (never public)", () => {
    for (const p of [
      "/api/hub/public/../entities",
      "/api/hub/public/%2e%2e/entities",
      "/api/hub/public//shares/x",
      "/api/hub/public/shares%2Fx",
      "/api/hub/public\\shares\\x",
      "/api/hub/public/",
      "/api/hub/publicx/shares/x",
      "/api/hubx/public/shares/x",
      "/public/shares/x",
    ]) {
      expect(isPublicDoorPath(p), p).toBe(false);
    }
    expect(isPublicDoorPath("/api/hub/public/shares/x")).toBe(true);
  });
});

describe("public doors — no layer keeps its own list", () => {
  const CONSUMERS = [
    path.join(
      BACKEND,
      "packages/api/src/routers/hub-protocol/_middleware/auth.ts"
    ),
    path.join(
      BACKEND,
      "packages/api/src/routers/hub-protocol/_middleware/idempotency.ts"
    ),
    path.join(HERE, "middleware/rate-limit-classes.ts"),
    path.join(HERE, "pod-edge-cors.ts"),
    path.join(HERE, "public-door-transport.ts"),
    path.join(HERE, "cors-origin.ts"),
  ];

  it("every consumer calls isPublicDoorPath", () => {
    for (const file of CONSUMERS) {
      expect(readFileSync(file, "utf8"), file).toMatch(/\bisPublicDoorPath\(/);
    }
  });

  it("DERIVED: no source spells a `/public/` path literal except the predicate module and the route files", () => {
    const LITERAL = /["'`](?:\/api\/hub(?:-protocol)?)?\/public\//;
    expect(LITERAL.test(`"/public/projection"`)).toBe(true); // self-check
    expect(LITERAL.test(codeOnly(`// "/public/x"\nconst a = 1;`))).toBe(false);
    expect(
      LITERAL.test(codeOnly(`/** "/public/x" */\nconst p = "/public/x";`))
    ).toBe(true);
    const roots = [
      HERE,
      path.join(BACKEND, "packages/api/src/routers/hub-protocol"),
    ];
    const scanned = roots.flatMap((r) => walk(r)).filter((f) => !isTest(f));
    expect(scanned.length).toBeGreaterThan(60); // non-vacuity
    const offenders = scanned.filter((f) => {
      if (f.startsWith(HUB_REST + path.sep)) return false; // route registrations
      return LITERAL.test(codeOnly(readFileSync(f, "utf8")));
    });
    expect(offenders).toEqual([]);
    // The predicate module itself is where the namespace is spelled.
    expect(
      LITERAL.test(
        readFileSync(
          path.join(BACKEND, "packages/api/src/public-doors.ts"),
          "utf8"
        )
      )
    ).toBe(true);
  });

  it("index.ts mounts the public transport FIRST, before the credentialed CORS", () => {
    const src = readFileSync(path.join(HERE, "index.ts"), "utf8");
    const uses = [...src.matchAll(/^app\.use\(\s*"\*",\s*([A-Za-z]+)/gm)].map(
      (m) => m[1]
    );
    expect(uses.length).toBeGreaterThan(3); // non-vacuity
    expect(uses[0]).toBe("publicDoorTransport");
    expect(uses[1]).toBe("podEdgeCorsMiddleware");
    expect(uses).toContain("httpCacheHeadersMiddleware");
  });
});
