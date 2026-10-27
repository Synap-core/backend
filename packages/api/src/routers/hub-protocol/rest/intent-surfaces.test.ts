/**
 * Hub REST intent-surface reads (surfaces W1.8) — thin doors over the tRPC
 * procedures. Asserted at the SEAM: the query a caller sends arrives at
 * `lifecycle.board` / `lifecycle.throughput` / `lifecycle.home` /
 * `lifecycle.moving` / `signals.list` / `signals.count` as the tRPC input (the procedures' own SQL is proven in
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
      home: record("home"),
      moving: record("moving"),
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
import { LENS_PAGE_READ_CAPS } from "@synap-core/types/lens";
import { registerIntentSurfacesRoutes } from "./intent-surfaces.js";
import type { HubHono, HubVariables } from "./_shared.js";

const P = "11111111-1111-4111-8111-111111111111";
const W = "33333333-3333-4333-8333-333333333333";

function app(
  scopes = ["hub-protocol.read"],
  keyWorkspaceId: string | null = null
): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", scopes);
    c.set("keyType", "service");
    c.set("keyWorkspaceId", keyWorkspaceId);
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

  it("home and moving: their narrowing lens reaches lifecycle.home / .moving", async () => {
    expect((await app().request(`/lifecycle/home?projectId=${P}`)).status).toBe(
      200
    );
    await app().request(`/lifecycle/home`);
    await app().request(
      `/lifecycle/moving?workspaceId=${P}&projectId=${P}&limit=5`
    );
    await app().request(`/lifecycle/moving`);
    expect(h.calls).toEqual([
      { proc: "home", input: { projectId: P } },
      { proc: "home", input: {} },
      {
        proc: "moving",
        input: { projectId: P, workspaceId: P, limit: 5 },
      },
      { proc: "moving", input: { limit: 30 } },
    ]);
    expect(
      (await app().request(`/lifecycle/moving?workspaceId=nope`)).status
    ).toBe(400);
    expect((await app([]).request(`/lifecycle/home`)).status).toBe(403);
    expect(h.calls).toHaveLength(4);
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

  it("lens-page: the page lens at the scope it was asked, with the lens hosts' caps", async () => {
    const since = "2026-10-27T00:00:00.000+01:00";
    expect(
      (
        await app().request(
          `/attention/lens-page?workspaceId=${P}&projectId=${P}&since=${encodeURIComponent(since)}`
        )
      ).status
    ).toBe(200);
    await app().request(`/attention/lens-page?sessionId=${P}`);
    await app().request(`/attention/lens-page`);
    // The caps every lens host reads with (web and relay), never a second set.
    const caps = { ...LENS_PAGE_READ_CAPS };
    expect(h.calls).toEqual([
      {
        proc: "signals.list",
        input: { lens: "page", workspaceId: P, projectId: P, caps, since },
      },
      { proc: "signals.list", input: { lens: "page", sessionId: P, caps } },
      { proc: "signals.list", input: { lens: "page", caps } },
    ]);
  });

  it("lens-page: a bad scope or since is a 400 and reaches nothing; no read scope is a 403", async () => {
    expect(
      (await app().request(`/attention/lens-page?trackId=nope`)).status
    ).toBe(400);
    expect(
      (await app().request(`/attention/lens-page?since=yesterday`)).status
    ).toBe(400);
    expect((await app([]).request(`/attention/lens-page`)).status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it("lens-page: a key bound to a workspace reads that workspace's page, never the pod's", async () => {
    const bound = () => app(undefined, W);
    expect((await bound().request(`/attention/lens-page`)).status).toBe(200);
    // The scope axes AND with the workspace: a session lens stays inside it.
    await bound().request(`/attention/lens-page?sessionId=${P}`);
    await bound().request(`/attention/lens-page?workspaceId=${W}`);
    const caps = { ...LENS_PAGE_READ_CAPS };
    expect(h.calls).toEqual([
      { proc: "signals.list", input: { lens: "page", workspaceId: W, caps } },
      {
        proc: "signals.list",
        input: { lens: "page", workspaceId: W, sessionId: P, caps },
      },
      { proc: "signals.list", input: { lens: "page", workspaceId: W, caps } },
    ]);
  });

  it("lens-page: a key bound to a workspace that names another is a 403 and reaches nothing", async () => {
    const res = await app(undefined, W).request(
      `/attention/lens-page?workspaceId=${P}`
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /confined to workspace/
    );
    expect(h.calls).toEqual([]);
  });

  // Every door that takes a workspace lens runs the one clamp (`readDoor`'s
  // `confineWorkspace`): a bound key reads only its workspace, another is a 403.
  const CONFINED = [
    ["lifecycle.board", "board", "/lifecycle/board?profileSlug=lead"],
    [
      "lifecycle.throughput",
      "throughput",
      "/lifecycle/throughput?profileSlug=lead",
    ],
    ["lifecycle.moving", "moving", "/lifecycle/moving?limit=5"],
    [
      "attention.needs-you",
      "signals.list",
      "/attention/needs-you?profileSlug=lead",
    ],
    ["attention.count", "signals.count", "/attention/count?profileSlug=lead"],
  ] as const;

  it.each(CONFINED)(
    "%s: a key bound to a workspace that names none reads only that workspace",
    async (_door, proc, url) => {
      expect((await app(undefined, W).request(url)).status).toBe(200);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]!.proc).toBe(proc);
      expect(h.calls[0]!.input).toMatchObject({ workspaceId: W });
    }
  );

  it.each(CONFINED)(
    "%s: a key bound to a workspace that names another is a 403 and reaches nothing",
    async (_door, _proc, url) => {
      const res = await app(undefined, W).request(`${url}&workspaceId=${P}`);
      expect(res.status).toBe(403);
      expect(h.calls).toEqual([]);
    }
  );

  it("lifecycle.home has no workspace axis: a bound key is refused, an unbound one reads", async () => {
    const res = await app(undefined, W).request(`/lifecycle/home`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /confined to workspace .* reads every space/
    );
    expect(h.calls).toEqual([]);
    expect((await app().request(`/lifecycle/home`)).status).toBe(200);
    expect(h.calls).toEqual([{ proc: "home", input: {} }]);
  });
});
