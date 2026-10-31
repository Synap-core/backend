/**
 * index.ts's /trpc refusals, through the REAL session gate and AI limit, are
 * tRPC errors (`trpcRefusals`, `@synap/api/trpc-refusal`).
 *
 * The envelope itself is tested against a real `@trpc/client` beside it
 * (packages/api `middleware/trpc-refusal.test.ts`). Here: the wiring.
 * `trpcSessionGate` + the real `@synap/auth` middleware, and
 * `trpcAiRateLimit` + the real `hono-rate-limiter` (which refuses by ASSIGNING
 * `c.res`, never returning it), each wrapped as index.ts wraps them. A tRPC
 * error body is a batch ARRAY of `{ error: { json: … } }` for `?batch=1`.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { trpcRefusals } from "@synap/api/trpc-refusal";
import { beforeAll, describe, expect, it } from "vitest";

import { trpcSessionGate } from "./trpc-session-gate.js";
import { trpcAiRateLimit } from "./trpc-ai-rate-limit.js";

let authMiddleware: MiddlewareHandler;

beforeAll(async () => {
  delete process.env.LOCAL_MODE;
  ({ authMiddleware } = await import("@synap/auth"));
});

const t = initTRPC.create();
const router = t.router({
  health: t.router({ alive: t.procedure.query(() => "ok") }),
  entities: t.router({ get: t.procedure.query(() => "entity") }),
  chat: t.router({ sendMessage: t.procedure.mutation(() => "sent") }),
});

function makeApp() {
  const trpcRefusal = trpcRefusals(router);
  const app = new Hono();
  app.use("/trpc/*", trpcRefusal(trpcSessionGate(authMiddleware)));
  app.use(
    "/trpc/*",
    trpcRefusal(
      trpcAiRateLimit(
        rateLimiter({
          windowMs: 60_000,
          limit: 1,
          standardHeaders: "draft-7",
          keyGenerator: () => "one-caller",
          handler: (c) => c.json({ error: "Too many AI requests" }, 429),
        })
      )
    )
  );
  app.use("/trpc/*", async (c) => {
    const res = await fetchRequestHandler({
      endpoint: "/trpc",
      req: c.req.raw,
      router,
      createContext: () => ({}),
    });
    return c.newResponse(res.body, res);
  });
  return app;
}

type Envelope = { error: { code: number; data: { code: string } } };

describe("index.ts's /trpc refusals are tRPC errors", () => {
  it("the session gate's 401, batched behind a public probe", async () => {
    const input = encodeURIComponent(JSON.stringify({ 0: {}, 1: {} }));
    const res = await makeApp().request(
      `/trpc/health.alive,entities.get?batch=1&input=${input}`
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
    expect((await makeApp().request("/trpc/health.alive")).status).toBe(200);
  });
});
