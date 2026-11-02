/**
 * index.ts's /trpc refusals, through the REAL edge chain, reach a REAL
 * `@trpc/client` as tRPC errors (`trpcEnvelope`, `@synap/api/trpc-refusal`).
 *
 * On 2026-11-02 the edge CORS 403, the size limit's 413 and the pod-edge rate
 * limit's 429 still came back as plain JSON ("Unable to transform response
 * from server" in the client): they are mounted on "*" in front of the
 * per-middleware wrappers of #621. The envelope is now the OUTERMOST /trpc
 * middleware.
 *
 * Driven in index.ts order: trpcEnvelope → publicDoorTransport →
 * podEdgeCorsMiddleware → requestSizeLimit → rateLimitMiddleware →
 * secureHeaders → httpCacheHeadersMiddleware → trpcSessionGate (real
 * `@synap/auth`) → trpcAiRateLimit (real `hono-rate-limiter`, which ASSIGNS
 * `c.res`) → the tRPC fetch adapter, marked as index.ts marks it. Stand-ins:
 * the router (no transformer: superjson is not a dependency here; packages/api
 * `middleware/trpc-refusal.test.ts` drives it), the origin-approval lookup and
 * the explicit-token check (both read the database). The crud budget is 2.
 *
 * NOT covered: index.ts itself cannot be imported (it boots a server), so
 * its ORDER is a source scan (last describe): it sees a moved `app.use`, not
 * a wrapper that re-orders at runtime. A real browser never reads the CORS
 * 403's body (no Access-Control-Allow-Origin): that one matters to a
 * non-browser client sending an Origin.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { rateLimiter } from "hono-rate-limiter";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import {
  TRPCClientError,
  createTRPCClient,
  httpBatchLink,
  httpLink,
} from "@trpc/client";
import {
  markTrpcAnswer,
  TRPC_MAX_BATCH_SIZE,
  trpcEnvelope,
} from "@synap/api/trpc-refusal";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { publicDoorTransport } from "./public-door-transport.js";
import { trpcSessionGate } from "./trpc-session-gate.js";
import { trpcAiRateLimit } from "./trpc-ai-rate-limit.js";
import { stripComments } from "../../../scripts/strip-comments.mjs";

vi.mock("./cors-origin.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./cors-origin.js")>();
  return { ...real, isApprovedApplicationOrigin: vi.fn(async () => false) };
});
vi.mock("./explicit-pod-session.js", () => ({
  validateExplicitPodSessionToken: vi.fn(async () => "invalid"),
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIRST_PARTY = "https://app.pod.example.test";
const FOREIGN = "https://someone.vercel.app";
const CRUD_BUDGET = 2;
const MB = 1024 * 1024;

let edge: {
  authMiddleware: MiddlewareHandler;
  podEdgeCorsMiddleware: MiddlewareHandler;
  httpCacheHeadersMiddleware: MiddlewareHandler;
  requestSizeLimit: MiddlewareHandler;
  rateLimitMiddleware: MiddlewareHandler;
};

beforeAll(async () => {
  delete process.env.LOCAL_MODE;
  process.env.DATABASE_URL ??=
    "postgresql://synap:test@localhost:5432/synap_test";
  process.env.SYNAP_BASE_DOMAIN = "pod.example.test";
  // Read when security.ts builds its limiters (import time).
  process.env.RATE_LIMIT_CRUD_MAX = String(CRUD_BUDGET);
  process.env.RATE_LIMIT_CRUD_IP_CEILING = "1000";
  const sec = await import("./middleware/security.js");
  const cors = await import("./pod-edge-cors.js");
  const { authMiddleware } = await import("@synap/auth");
  edge = {
    authMiddleware,
    podEdgeCorsMiddleware: cors.podEdgeCorsMiddleware,
    httpCacheHeadersMiddleware: cors.httpCacheHeadersMiddleware,
    requestSizeLimit: sec.requestSizeLimit,
    rateLimitMiddleware: sec.rateLimitMiddleware,
  };
}, 120_000);

const t = initTRPC.create();
const router = t.router({
  health: t.router({ alive: t.procedure.query(() => "ok") }),
  entities: t.router({
    get: t.procedure.query(() => "entity"),
    create: t.procedure
      .input((v) => v as { text: string })
      .mutation(({ input }) => input.text.length),
  }),
  chat: t.router({ sendMessage: t.procedure.mutation(() => "sent") }),
});

function makeApp() {
  const app = new Hono();
  app.use("/trpc/*", trpcEnvelope(router));
  app.use("*", publicDoorTransport);
  app.use("*", edge.podEdgeCorsMiddleware);
  app.use("*", edge.requestSizeLimit);
  app.use("*", edge.rateLimitMiddleware);
  app.use("*", secureHeaders());
  app.use("*", edge.httpCacheHeadersMiddleware);
  app.use("/trpc/*", trpcSessionGate(edge.authMiddleware));
  app.use(
    "/trpc/*",
    trpcAiRateLimit(
      rateLimiter({
        windowMs: 60_000,
        limit: 1,
        standardHeaders: "draft-7",
        keyGenerator: () => "one-caller",
        handler: (c) => c.json({ error: "Too many AI requests" }, 429),
      })
    )
  );
  app.use("/trpc/*", async (c) => {
    const res = await fetchRequestHandler({
      endpoint: "/trpc",
      req: c.req.raw,
      router,
      maxBatchSize: TRPC_MAX_BATCH_SIZE,
      createContext: () => ({}),
    });
    markTrpcAnswer(c);
    return c.newResponse(res.body, res);
  });
  return app;
}

/** A real client. Content-Length is set as a real HTTP stack sets it. */
function client(
  app: Hono,
  link: "batch" | "single",
  headers: Record<string, string> = {}
) {
  const opts = {
    url: "http://pod.example.test/trpc",
    headers: { ...freshIp(), ...headers },
    fetch: async (url: URL | RequestInfo, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      if (typeof init?.body === "string") {
        h.set("content-length", String(Buffer.byteLength(init.body)));
      }
      return app.request(String(url), { ...init, headers: h });
    },
  };
  return createTRPCClient<typeof router>({
    links: [link === "batch" ? httpBatchLink(opts) : httpLink(opts)],
  });
}

async function rejection(p: Promise<unknown>) {
  const err = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(TRPCClientError);
  return err as TRPCClientError<any>;
}

let n = 0;
/** A fresh crud bucket per test: the limiter's store is module-level. */
const freshKey = () =>
  `Bearer ${`synap_hub_envelope_${(n += 1)}_`.padEnd(48, "x")}`;
/** A fresh address, so no test spends another's address bucket. */
const freshIp = () => ({ "x-forwarded-for": `10.9.0.${(n += 1)}` });

describe.each(["batch", "single"] as const)(
  "the edge's refusals on /trpc are tRPC errors (%s link)",
  (link) => {
    it("the CORS 403 for an unapproved origin → FORBIDDEN", async () => {
      const err = await rejection(
        client(makeApp(), link, { origin: FOREIGN }).health.alive.query()
      );
      expect(err.data?.code).toBe("FORBIDDEN");
      expect(err.data?.httpStatus).toBe(403);
      expect(err.message).toBe(
        "This browser origin is not approved for this Pod"
      );
    });

    it("the size limit's 413 for a body over 10 MB → PAYLOAD_TOO_LARGE", async () => {
      const err = await rejection(
        client(makeApp(), link).entities.create.mutate({
          text: "x".repeat(10 * MB + 1),
        })
      );
      expect(err.data?.code).toBe("PAYLOAD_TOO_LARGE");
      expect(err.data?.httpStatus).toBe(413);
      expect(err.message).toBe("Request body must be less than 10MB");
    });

    it("the rate limit's 429 → TOO_MANY_REQUESTS; Retry-After is kept AND exposed to the console's origin", async () => {
      const c = client(makeApp(), link, {
        authorization: freshKey(),
        origin: FIRST_PARTY,
      });
      for (let i = 0; i < CRUD_BUDGET; i++) {
        expect(await c.health.alive.query()).toBe("ok");
      }
      const err = await rejection(c.health.alive.query());
      expect(err.data?.code).toBe("TOO_MANY_REQUESTS");
      expect(err.data?.httpStatus).toBe(429);
      expect(err.message).toBe("Rate limit exceeded. Please try again later.");
      const res = err.meta?.response as Response;
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(res.headers.get("access-control-allow-origin")).toBe(FIRST_PARTY);
      const exposed = (res.headers.get("access-control-expose-headers") ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase());
      expect(exposed).toEqual(
        expect.arrayContaining(["retry-after", "ratelimit", "ratelimit-policy"])
      );
      expect(res.headers.get("ratelimit")).toMatch(/^limit=\d+, remaining=0/);
    });
  }
);

type Envelope = { error: { code: number; data: { code: string } } };

describe("the /trpc guards behind the edge are tRPC errors too", () => {
  it("the session gate's 401, batched behind a public probe", async () => {
    const input = encodeURIComponent(JSON.stringify({ 0: {}, 1: {} }));
    const res = await makeApp().request(
      `/trpc/health.alive,entities.get?batch=1&input=${input}`,
      { headers: freshIp() }
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as Envelope[];
    expect(body.map((e) => e.error.data.code)).toEqual([
      "UNAUTHORIZED",
      "UNAUTHORIZED",
    ]);
  });

  it("the AI limit's 429 (hono-rate-limiter, assigned), Retry-After kept", async () => {
    const app = makeApp();
    const send = () =>
      app.request("/trpc/chat.sendMessage", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "mock-session-cookie=u1",
          ...freshIp(),
        },
        body: "{}",
      });
    expect((await send()).status).toBe(200);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    const body = (await res.json()) as Envelope;
    expect(body.error.data.code).toBe("TOO_MANY_REQUESTS");
    expect(body.error.code).toBe(-32029);
  });

  it("CONTROL — the public probe alone still runs with no session", async () => {
    const res = await makeApp().request("/trpc/health.alive", {
      headers: freshIp(),
    });
    expect(res.status).toBe(200);
  });
});

describe("index.ts mounts the envelope outermost and marks the adapter", () => {
  const src = stripComments(
    readFileSync(path.join(HERE, "index.ts"), "utf8"),
    "ts"
  ) as string;

  it("the first app.use of index.ts is the /trpc envelope", () => {
    const uses = [...src.matchAll(/^app\.use\(([^\n]*)$/gm)].map((m) =>
      m[1]!.trim()
    );
    expect(uses.length).toBeGreaterThan(5); // non-vacuity
    expect(uses[0]).toBe('"/trpc/*", trpcEnvelope(appRouter));');
  });

  it("the /trpc adapter marks its answer; both tRPC adapters cap the batch", () => {
    const adapters = [
      ...src.matchAll(/fetchRequestHandler\(\{[\s\S]*?\n {2}\}\);/g),
    ].map((m) => m[0]);
    expect(adapters).toHaveLength(2); // /trpc and /api/hub/trpc
    for (const a of adapters) {
      expect(a).toContain("maxBatchSize: TRPC_MAX_BATCH_SIZE");
    }
    expect(src).toMatch(
      /router: appRouter,[\s\S]*?\}\);\s*markTrpcAnswer\(c\);\s*return c\.newResponse/
    );
  });
});
