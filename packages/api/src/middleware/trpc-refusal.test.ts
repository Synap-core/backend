/**
 * Refusals in front of main `/trpc` reach a REAL `@trpc/client` as tRPC errors.
 *
 * They were plain JSON (`{ error: "Unauthorized", details: … }`): the client
 * threw "Unable to transform response from server", with no `data.code`, and
 * apps retried a 401 three times (incident 2026-10-31).
 *
 * Driven through `httpBatchLink` + superjson (the pod's transformer,
 * `init-trpc.ts`), the REAL session middleware (`@synap/auth`) and the REAL
 * tRPC fetch adapter. The AI limit is a stand-in that refuses the way apps/api
 * `trpcAiRateLimit` + `hono-rate-limiter` do: headers set, then `c.res =`
 * the refusal, `next` never called. apps/api's `trpc-refusal.test.ts` drives
 * the real ones, mounted as index.ts mounts them.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCClientError, createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { beforeAll, describe, expect, it } from "vitest";

import { trpcPath, trpcRefusals } from "./trpc-refusal.js";

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
    }),
    chat: t.router({
      sendMessage: t.procedure.mutation(() => {
        reached++;
        return "sent";
      }),
    }),
  });
}

const AI_LIMIT = 1;
const MOCK_SESSION = { cookie: "mock-session-cookie=u1" };

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
  const trpcRefusal = trpcRefusals(router);
  const app = new Hono();
  // Stands in for the global CORS middleware: headers set before `next`.
  app.use("*", async (c, next) => {
    c.header("access-control-allow-origin", "https://app.test");
    c.header("vary", "Origin");
    await next();
  });
  app.use("/trpc/*", trpcRefusal(session ?? authMiddleware));
  app.use("/trpc/*", trpcRefusal(aiLimitStandIn()));
  app.use("/trpc/*", async (c) => {
    const res = await fetchRequestHandler({
      endpoint: "/trpc",
      req: c.req.raw,
      router,
      createContext: () => ({}),
    });
    return c.newResponse(res.body, res);
  });
  // A non-/trpc route behind the same session middleware, unwrapped.
  app.use("/api/chat/*", authMiddleware);
  app.get("/api/chat/x", (c) => c.json({ ok: true }));

  const requests: string[] = [];
  const client = (headers: Record<string, string> = {}) =>
    createTRPCClient<typeof router>({
      links: [
        httpBatchLink({
          url: "http://pod.test/trpc",
          transformer: superjson,
          headers,
          fetch: async (url, init) => {
            requests.push(String(url));
            return app.request(String(url), init as RequestInit);
          },
        }),
      ],
    });
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

describe("a refused /trpc call is a tRPC error", () => {
  it("one call with no session → UNAUTHORIZED, 401, the gate's message", async () => {
    const before = reached;
    const { client } = makeApp();
    const err = await rejection(client().workspaces.list.query());
    expect(err.data?.code).toBe("UNAUTHORIZED");
    expect(err.data?.httpStatus).toBe(401);
    expect(err.data?.path).toBe("workspaces.list");
    expect(err.message).toBe("No session cookie or token");
    expect((err.meta?.response as Response).status).toBe(401);
    expect(reached).toBe(before);
  });

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

  it("the AI limit's refusal → TOO_MANY_REQUESTS, 429, Retry-After kept", async () => {
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
    const res401 =
      await makeApp(invalidToken).app.request("/trpc/entities.get");
    expect(res401.status).toBe(401);
    expect(res401.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"'
    );
    expect(res401.headers.get("access-control-allow-origin")).toBe(
      "https://app.test"
    );
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

describe("what the envelope must not change", () => {
  it("a signed-in call still runs and returns its data", async () => {
    const before = reached;
    const { client } = makeApp();
    const rows = await client(MOCK_SESSION).workspaces.list.query();
    expect(rows[0]!.at).toBeInstanceOf(Date);
    expect(reached).toBe(before + 1);
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
    expect(trpcPath("/api/hub/trpc/x.y", "/api/hub/trpc")).toBe("x.y");
  });

  it("a HEAD refusal stays the middleware's 401 (tRPC would answer 204)", async () => {
    const res = await makeApp().app.request("/trpc/entities.get", {
      method: "HEAD",
    });
    expect(res.status).toBe(401);
  });
});
