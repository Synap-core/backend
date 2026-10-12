/**
 * Hub REST intent-surface reads (surfaces W1.8) — thin doors over the tRPC
 * procedures. Asserted at the SEAM: the query a caller sends arrives at
 * `lifecycle.board` / `lifecycle.throughput` / `signals.list` /
 * `signals.count` as the tRPC input (the procedures' own SQL is proven in
 * their PGlite suites), a bad query is a 400, a missing scope a 403, and a
 * TRPCError keeps its status (an unknown kind is a 404, never a 500).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ proc: string; input: unknown }>,
  fail: null as null | Error,
}));

const record =
  (proc: string) =>
  async (input: unknown): Promise<unknown> => {
    if (h.fail) throw h.fail;
    h.calls.push({ proc, input });
    return { ok: proc };
  };

vi.mock("../../lifecycle.js", () => ({
  lifecycleRouter: {
    createCaller: () => ({
      board: record("board"),
      throughput: record("throughput"),
    }),
  },
}));
vi.mock("../../signals.js", () => ({
  signalsRouter: {
    createCaller: () => ({
      list: record("signals.list"),
      count: record("signals.count"),
    }),
  },
}));
vi.mock("../utils.js", () => ({
  createHubProtocolCallerContext: async (userId: string) => ({ userId }),
}));

import { TRPCError } from "@trpc/server";
import { registerIntentSurfacesRoutes } from "./intent-surfaces.js";
import type { HubHono, HubVariables } from "./_shared.js";

const P = "11111111-1111-4111-8111-111111111111";

function app(scopes = ["hub-protocol.read"]): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", scopes);
    await next();
  });
  registerIntentSurfacesRoutes(a);
  return a;
}

describe("Hub REST intent-surface reads", () => {
  beforeEach(() => {
    h.calls = [];
    h.fail = null;
  });

  it("board: the lens, window, paging and workedBy reach lifecycle.board", async () => {
    const res = await app().request(
      `/lifecycle/board?profileSlug=lead&projectId=${P}&windowDays=7&firstN=3&column=new&limit=5&workedBy=true`
    );
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([
      {
        proc: "board",
        input: {
          profileSlug: "lead",
          projectId: P,
          window: { days: 7 },
          firstN: 3,
          column: "new",
          limit: 5,
          workedBy: true,
        },
      },
    ]);
  });

  it("throughput, needs-you and count carry the intent lens", async () => {
    await app().request(
      `/lifecycle/throughput?profileSlug=post&trackId=${P}&bucket=month&count=6`
    );
    await app().request(`/attention/needs-you?profileSlug=post&limit=10`);
    await app().request(`/attention/count?profileSlug=post&workspaceId=${P}`);
    expect(h.calls).toEqual([
      {
        proc: "throughput",
        input: {
          profileSlug: "post",
          trackId: P,
          period: { bucket: "month", count: 6 },
        },
      },
      {
        proc: "signals.list",
        input: { profileSlug: "post", lens: "needs-you", limit: 10 },
      },
      {
        proc: "signals.count",
        input: { profileSlug: "post", workspaceId: P },
      },
    ]);
  });

  it("a bad query is a 400 and reaches nothing; no read scope is a 403", async () => {
    expect((await app().request(`/lifecycle/board`)).status).toBe(400);
    expect(
      (await app().request(`/lifecycle/board?profileSlug=lead&projectId=nope`))
        .status
    ).toBe(400);
    expect(
      (await app([]).request(`/attention/count?profileSlug=lead`)).status
    ).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it("a TRPCError keeps its status — an unknown kind is a 404", async () => {
    h.fail = new TRPCError({ code: "NOT_FOUND", message: "no such kind" });
    const res = await app().request(`/attention/count?profileSlug=nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "no such kind"
    );
  });
});
