/**
 * Every refusal in front of main `/trpc` reaches a REAL `@trpc/client` as a
 * tRPC error (`trpcEnvelope`).
 *
 * They were plain JSON (`{ error: "Unauthorized", details: … }`): the client
 * threw "Unable to transform response from server", with no `data.code`, and
 * apps retried a 401 three times (incident 2026-10-31). On 2026-11-02 the
 * edge CORS 403, the size limit's 413 and the rate limit's 429 still came back
 * that way: they are mounted on "*" before the per-middleware wrappers of
 * #621, so only the session gate and the AI limit were wrapped.
 *
 * Driven through `httpBatchLink` and `httpLink` + superjson (the pod's
 * transformer, `init-trpc.ts`), the REAL session middleware (`@synap/auth`)
 * and the REAL tRPC fetch adapter. The edge middlewares are stand-ins that
 * refuse the way apps/api's do (status, body keys, headers; returned, or
 * assigned to `c.res` like `trpcAiRateLimit`). apps/api's `trpc-refusal.test.ts`
 * drives the real ones, mounted in index.ts order.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import {
  TRPCClientError,
  createTRPCClient,
  httpBatchLink,
  httpLink,
} from "@trpc/client";
import superjson from "superjson";
import { beforeAll, describe, expect, it } from "vitest";

import {
  markTrpcAnswer,
  TRPC_MAX_BATCH_SIZE,
  trpcEnvelope,
  trpcPath,
} from "./trpc-refusal.js";

let authMiddleware: MiddlewareHandler;

beforeAll(async () => {
  delete process.env.LOCAL_MODE;
  ({ authMiddleware } = await import("@synap/auth"));
});

let reached = 0;
function makeRouter() {
  const t = initTRPC.create({ transformer: superjson });
  return t.router({
    workspaces: t.router({
      list: t.procedure.query(() => {
        reached++;
        return [{ at: new Date(0) }];
      }),
    }),
    entities: t.router({
      get: t.procedure.query(() => {
        reached++;
        return "entity";
      }),
      create: t.procedure
        .input((v) => v as { text: string })
        .mutation(({ input }) => {
          reached++;
          return input.text.length;
        }),
    }),
    chat: t.router({
      sendMessage: t.procedure.mutation(() => {
        reached++;
        return "sent";
      }),
    }),
    owner: t.router({
      only: t.procedure.query(() => {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the owner can do that.",
        });
      }),
    }),
  });
}

const FIRST_PARTY = "https://app.pod.test";
const FOREIGN = "https://someone.example";
const BODY_LIMIT = 1_000;
const AI_LIMIT = 1;
const MOCK_SESSION = { cookie: "mock-session-cookie=u1" };

/** The edge CORS (`podEdgeCorsMiddleware`): headers for a first party, a 403 for a stranger. */
const corsStandIn: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin === FIRST_PARTY) {
    c.header("access-control-allow-origin", origin);
    c.header("vary", "Origin");
  } else if (origin) {
    return c.json(
      {
        error: "This browser origin is not approved for this Pod",
        code: "BROWSER_ORIGIN_NOT_APPROVED",
        remediation: "approve_browser_origin",
        origin,
      },
      403
    );
  }
  await next();
};

/** `requestSizeLimit`: reads Content-Length only. */
const sizeLimitStandIn: MiddlewareHandler = async (c, next) => {
  if (Number(c.req.header("content-length")) > BODY_LIMIT) {
    return c.json(
      {
        error: "Payload too large",
        message: "Request body must be less than 1KB",
      },
      413
    );
  }
  await next();
};

/** `rateLimitMiddleware` (hono-rate-limiter + `classHandler`): a `Bearer burst-*` key gets one call. */
function edgeRateStandIn(): MiddlewareHandler {
  const hits = new Map<string, number>();
  return async (c, next) => {
    const key = c.req.header("authorization") ?? "";
    if (!key.startsWith("Bearer burst-")) return next();
    const n = (hits.get(key) ?? 0) + 1;
    hits.set(key, n);
    c.header("RateLimit-Policy", "1;w=900");
    c.header("RateLimit", "limit=1, remaining=0, reset=900");
    if (n <= 1) return next();
    c.header("Retry-After", "900");
    return c.json(
      {
        error: "Too many requests",
        message: "Rate limit exceeded. Please try again later.",
        retryAfter: "15 minutes",
        class: "crud",
        limit: 1,
      },
      429
    );
  };
}

/** Refuses like `trpcAiRateLimit(aiRateLimitMiddleware)` once over the limit. */
function aiLimitStandIn(): MiddlewareHandler {
  let hits = 0;
  return async (c, next) => {
    if (!c.req.path.includes("chat.sendMessage") || ++hits <= AI_LIMIT) {
      return next();
    }
    c.header("RateLimit-Policy", `${AI_LIMIT};w=60`);
    c.header("Retry-After", "60");
    c.res = c.json(
      {
        error: "Too many AI requests",
        message: "AI endpoint rate limit exceeded.",
      },
      429
    );
  };
}

/** index.ts's /trpc stack; `session` sits where the session gate sits. */
function makeApp(session?: MiddlewareHandler) {
  const router = makeRouter();
  const app = new Hono();
  app.use("/trpc/*", trpcEnvelope(router));
  app.use("*", corsStandIn);
  app.use("*", sizeLimitStandIn);
  app.use("*", edgeRateStandIn());
  app.use("/trpc/*", session ?? authMiddleware);
  app.use("/trpc/*", aiLimitStandIn());
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
  // A non-/trpc route behind the same session middleware.
  app.use("/api/chat/*", authMiddleware);
  app.get("/api/chat/x", (c) => c.json({ ok: true }));

  const requests: string[] = [];
  /** A real client; Content-Length set as a real HTTP stack would. */
  const client = (
    headers: Record<string, string> = {},
    link: "batch" | "single" = "batch"
  ) => {
    const opts = {
      url: "http://pod.test/trpc",
      transformer: superjson,
      headers,
      fetch: async (url: URL | RequestInfo, init?: RequestInit) => {
        requests.push(String(url));
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
  };
  return { app, client, requests };
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

let burst = 0;
const LINKS = ["batch", "single"] as const;

describe.each(LINKS)(
  "every refusal in front of /trpc is a tRPC error (%s link)",
  (link) => {
    it("the edge CORS 403 → FORBIDDEN, with the refusal's words", async () => {
      const before = reached;
      const { client } = makeApp();
      const err = await rejection(
        client({ origin: FOREIGN }, link).workspaces.list.query()
      );
      expect(err.data?.code).toBe("FORBIDDEN");
      expect(err.data?.httpStatus).toBe(403);
      expect(err.message).toBe(
        "This browser origin is not approved for this Pod"
      );
      expect((err.meta?.response as Response).status).toBe(403);
      expect(reached).toBe(before);
    });

    it("the size limit's 413 → PAYLOAD_TOO_LARGE", async () => {
      const before = reached;
      const { client } = makeApp();
      const err = await rejection(
        client(MOCK_SESSION, link).entities.create.mutate({
          text: "x".repeat(BODY_LIMIT * 2),
        })
      );
      expect(err.data?.code).toBe("PAYLOAD_TOO_LARGE");
      expect(err.data?.httpStatus).toBe(413);
      expect(err.message).toBe("Request body must be less than 1KB");
      expect(reached).toBe(before);
    });

    it("the edge rate limit's 429 → TOO_MANY_REQUESTS, Retry-After and RateLimit kept", async () => {
      const { client } = makeApp();
      const c = client({ authorization: `Bearer burst-${(burst += 1)}` }, link);
      await rejection(c.workspaces.list.query()); // the one call: the gate's 401
      const err = await rejection(c.workspaces.list.query());
      expect(err.data?.code).toBe("TOO_MANY_REQUESTS");
      expect(err.data?.httpStatus).toBe(429);
      expect(err.message).toBe("Rate limit exceeded. Please try again later.");
      const res = err.meta?.response as Response;
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("900");
      expect(res.headers.get("ratelimit")).toBe(
        "limit=1, remaining=0, reset=900"
      );
    });

    it("the session gate's 401 → UNAUTHORIZED, the gate's message", async () => {
      const before = reached;
      const { client } = makeApp();
      const err = await rejection(client({}, link).workspaces.list.query());
      expect(err.data?.code).toBe("UNAUTHORIZED");
      expect(err.data?.httpStatus).toBe(401);
      expect(err.data?.path).toBe("workspaces.list");
      expect(err.message).toBe("No session cookie or token");
      expect(reached).toBe(before);
    });
  }
);

describe("a refused /trpc call is a tRPC error", () => {
  it("a batch of two → two UNAUTHORIZED errors in one 401 response", async () => {
    const before = reached;
    const { client, requests } = makeApp();
    const c = client();
    const [a, b] = await Promise.all([
      rejection(c.workspaces.list.query()),
      rejection(c.entities.get.query()),
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("workspaces.list,entities.get");
    expect(requests[0]).toContain("batch=1");
    for (const [err, p] of [
      [a, "workspaces.list"],
      [b, "entities.get"],
    ] as const) {
      expect(err.data?.code).toBe("UNAUTHORIZED");
      expect(err.data?.httpStatus).toBe(401);
      expect(err.data?.path).toBe(p);
    }
    expect(reached).toBe(before);
  });

  it("the raw batch body is the transformer's envelope, one per procedure", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/trpc/workspaces.list,entities.get?batch=1&input=%7B%7D"
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as Array<{
      error: { json: { code: number; data: { code: string } } };
    }>;
    expect(body).toHaveLength(2);
    expect(body.map((e) => e.error.json.data.code)).toEqual([
      "UNAUTHORIZED",
      "UNAUTHORIZED",
    ]);
    expect(body[0]!.error.json.code).toBe(-32001);
  });

  it("the AI limit's refusal (assigned to c.res) → TOO_MANY_REQUESTS, 429, Retry-After kept", async () => {
    const before = reached;
    const { app, client } = makeApp();
    const c = client(MOCK_SESSION);
    for (let i = 0; i < AI_LIMIT; i++) {
      expect(await c.chat.sendMessage.mutate()).toBe("sent");
    }
    const err = await rejection(c.chat.sendMessage.mutate());
    expect(err.data?.code).toBe("TOO_MANY_REQUESTS");
    expect(err.data?.httpStatus).toBe(429);
    expect(err.message).toBe("AI endpoint rate limit exceeded.");
    expect(reached).toBe(before + AI_LIMIT);

    const raw = await app.request("/trpc/chat.sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json", ...MOCK_SESSION },
      body: "{}",
    });
    expect(raw.status).toBe(429);
    expect(raw.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(raw.headers.get("ratelimit-policy")).toBe(`${AI_LIMIT};w=60`);
    expect(((await raw.json()) as any).error.json.data.code).toBe(
      "TOO_MANY_REQUESTS"
    );
  });

  it("WWW-Authenticate, CORS and a 503 survive (app-session's refusals)", async () => {
    const invalidToken: MiddlewareHandler = async (c) => {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "invalid_token" }, 401);
    };
    const res401 = await makeApp(invalidToken).app.request(
      "/trpc/entities.get",
      { headers: { origin: FIRST_PARTY } }
    );
    expect(res401.status).toBe(401);
    expect(res401.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"'
    );
    expect(res401.headers.get("access-control-allow-origin")).toBe(FIRST_PARTY);
    // tRPC's own `vary` and the refusal's are both kept.
    expect(res401.headers.get("vary")).toBe("trpc-accept, accept, Origin");
    expect(((await res401.json()) as any).error.json.message).toBe(
      "invalid_token"
    );

    const unavailable: MiddlewareHandler = async (c) =>
      c.json(
        {
          error: "auth_service_unavailable",
          message: "Sign-in could not be checked. Please retry.",
        },
        503
      );
    const err = await rejection(
      makeApp(unavailable).client().entities.get.query()
    );
    expect(err.data?.code).toBe("SERVICE_UNAVAILABLE");
    expect(err.data?.httpStatus).toBe(503);
    expect(err.message).toBe("Sign-in could not be checked. Please retry.");
  });
});

describe("batch size (TRPC_MAX_BATCH_SIZE)", () => {
  const batchUrl = (n: number) => {
    const input = encodeURIComponent(JSON.stringify({}));
    return `/trpc/${Array(n).fill("entities.get").join(",")}?batch=1&input=${input}`;
  };

  it("an unauthenticated batch over the limit is ONE 400 answer, not one error per call", async () => {
    const res = await makeApp().app.request(batchUrl(TRPC_MAX_BATCH_SIZE + 1));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(Array.isArray(body)).toBe(false);
    expect(body.error.json.data.code).toBe("BAD_REQUEST");
    expect(body.error.json.message).toBe("Batch call exceeds maximum size");
  });

  it("…and a real client rejects every call of it from that one answer", async () => {
    const { client, requests } = makeApp();
    const c = client();
    const errs = await Promise.all(
      Array.from({ length: TRPC_MAX_BATCH_SIZE + 1 }, () =>
        rejection(c.entities.get.query())
      )
    );
    expect(requests).toHaveLength(1);
    expect(new Set(errs.map((e) => e.data?.code))).toEqual(
      new Set(["BAD_REQUEST"])
    );
  });

  it("a batch AT the limit is still answered per call", async () => {
    const res = await makeApp().app.request(batchUrl(TRPC_MAX_BATCH_SIZE));
    expect(res.status).toBe(401);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(TRPC_MAX_BATCH_SIZE);
  });

  it("a signed-in batch over the limit is refused by the adapter too", async () => {
    const before = reached;
    const res = await makeApp().app.request(batchUrl(TRPC_MAX_BATCH_SIZE + 1), {
      headers: MOCK_SESSION,
    });
    expect(res.status).toBe(400);
    expect(reached).toBe(before);
  });
});

describe("what the envelope must not change", () => {
  it("a signed-in call still runs and returns its data", async () => {
    const before = reached;
    const { client } = makeApp();
    const rows = await client(MOCK_SESSION).workspaces.list.query();
    expect(rows[0]!.at).toBeInstanceOf(Date);
    expect(reached).toBe(before + 1);
  });

  it("an error tRPC answered itself goes out untouched (its own words)", async () => {
    const { client } = makeApp();
    const err = await rejection(client(MOCK_SESSION).owner.only.query());
    expect(err.data?.code).toBe("FORBIDDEN");
    expect(err.message).toBe("Only the owner can do that.");
  });

  it("a non-/trpc route's refusal is byte-identical to the middleware's own", async () => {
    const bare = new Hono();
    bare.use("/api/chat/*", authMiddleware);
    const expected = await bare.request("/api/chat/x");
    const res = await makeApp().app.request("/api/chat/x");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(await expected.text());
    expect(res.headers.get("content-type")).toBe(
      expected.headers.get("content-type")
    );
  });

  it("a status tRPC has no code for is left as it was", async () => {
    const teapot: MiddlewareHandler = async (c) =>
      c.json({ error: "teapot" }, 418);
    const res = await makeApp(teapot).app.request("/trpc/entities.get");
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ error: "teapot" });
  });

  it("trpcPath is the fetch adapter's path: raw, endpoint and slashes trimmed", () => {
    expect(trpcPath("http://pod.test/trpc/a.b,c.d?batch=1")).toBe("a.b,c.d");
    expect(trpcPath("/trpc/a.b%2Cc.d/")).toBe("a.b%2Cc.d");
  });

  it("a HEAD refusal stays the middleware's 401 (tRPC would answer 204)", async () => {
    const res = await makeApp().app.request("/trpc/entities.get", {
      method: "HEAD",
    });
    expect(res.status).toBe(401);
  });
});
