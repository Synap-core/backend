/**
 * `library.readers` / `library.readWith` — who may SEE readers and who may
 * SPEND one. An agent key or the IS internal key may read the offers (tRPC
 * and Hub REST GET), but `readWith` — a tap that may bill the person's
 * account — is the person's alone: FORBIDDEN before the service runs, and
 * Hub REST has no write for it at all. A failed reader lookup surfaces as an
 * error on both doors, never as an empty offer list. The service is stubbed
 * (its own pglite suite).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({
  ran: [] as string[],
  fail: false,
  args: [] as Array<Record<string, unknown>>,
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../services/library/readers.js", () => ({
  libraryReaders: async (args: Record<string, unknown>) => {
    h.ran.push("readers");
    h.args.push(args);
    if (h.fail) throw new Error("registry down");
    return {
      offers: [
        { readerId: "builtin", name: "Synap", billing: "none", state: "ready" },
      ],
    };
  },
  libraryReadWith: async (args: Record<string, unknown>) => {
    h.ran.push("readWith");
    h.args.push(args);
    return { queued: 1, overBudget: 0, skipped: 0 };
  },
  libraryReaderAvailability: () => async () => new Map(),
}));
vi.mock("../services/library/retry-media.js", () => ({
  libraryRetryMedia: async () => {
    h.ran.push("retryMedia");
    return { queued: 2 };
  },
}));

import { libraryRouter } from "./library.js";
import { registerLibraryRoutes } from "./hub-protocol/rest/library.js";
import type { Context } from "../types/context.js";

const ITEM = "00000000-0000-4000-8000-000000000001";
const caller = (extra: Record<string, unknown> = {}) =>
  libraryRouter.createCaller({
    authenticated: true,
    userId: "person-1",
    workspaceId: null,
    ...extra,
  } as unknown as Context);

function appAs(vars: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set(
      "scopes" as never,
      ["hub-protocol.read", "hub-protocol.write"] as never
    );
    c.set("userId" as never, "person-1" as never);
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    await next();
  });
  registerLibraryRoutes(app as never);
  return app;
}

beforeEach(() => {
  h.args.length = 0;
  h.ran.length = 0;
  h.fail = false;
});

describe("library.readWith is the person's tap only", () => {
  for (const [who, extra] of [
    ["an agent key", { agentUserId: "agent-1" }],
    ["the IS internal key", { keyType: "is_internal" }],
  ] as const) {
    it(`${who} is FORBIDDEN before anything runs — but may see the offers`, async () => {
      await expect(
        caller(extra).readWith({
          itemIds: [ITEM],
          readerId: "capture_social_post",
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(h.ran).toEqual([]);
      await caller(extra).readers({ itemId: ITEM });
      expect(h.ran).toEqual(["readers"]);
    });
  }

  it("tRPC threads the caller: an agent's offers stay lensed", async () => {
    await caller({ agentUserId: "agent-1" }).readers({ itemId: ITEM });
    await caller({ keyType: "is_internal" }).readers({ itemId: ITEM });
    await caller().readers({ itemId: ITEM });
    expect(h.args.map((a) => a.caller)).toEqual([
      { agentUserId: "agent-1", keyType: undefined },
      { agentUserId: undefined, keyType: "is_internal" },
      { agentUserId: undefined, keyType: undefined },
    ]);
  });

  for (const [who, extra] of [
    ["an agent key", { agentUserId: "agent-1" }],
    ["the IS internal key", { keyType: "is_internal" }],
  ] as const) {
    it(`retryMedia: ${who} is FORBIDDEN before anything runs`, async () => {
      await expect(
        caller(extra).retryMedia({ itemId: ITEM })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(h.ran).toEqual([]);
    });
  }

  it("a person reaches retryMedia", async () => {
    expect(await caller().retryMedia({ itemId: ITEM })).toEqual({ queued: 2 });
    expect(h.ran).toEqual(["retryMedia"]);
  });

  it("a person reaches readWith", async () => {
    expect(
      await caller().readWith({
        groupId: ITEM,
        readerId: "capture_social_post",
      })
    ).toEqual({ queued: 1, overBudget: 0, skipped: 0 });
    expect(h.ran).toEqual(["readWith"]);
  });

  it("exactly one target: both or neither is refused before the service", async () => {
    await expect(caller().readers({})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller().readers({ itemId: ITEM, groupId: ITEM })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().readWith({ itemIds: [ITEM], groupId: ITEM, readerId: "x" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.ran).toEqual([]);
  });

  it("a failed lookup is an error on tRPC, never an empty list", async () => {
    h.fail = true;
    await expect(caller().readers({ itemId: ITEM })).rejects.toThrow(
      /registry down/
    );
  });
});

describe("Hub REST /library/readers", () => {
  it("an agent key SEES the offers (GET)", async () => {
    const res = await appAs({ agentUserId: "agent-1" }).request(
      `/library/readers?itemId=${ITEM}`
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      offers: [{ readerId: "builtin" }],
    });
  });

  it("threads the caller: an agent's offers stay lensed", async () => {
    await appAs({ agentUserId: "agent-1" }).request(
      `/library/readers?itemId=${ITEM}`
    );
    await appAs({ keyType: "is_internal" }).request(
      `/library/readers?groupId=${ITEM}`
    );
    expect(h.args.map((a) => a.caller)).toEqual([
      { agentUserId: "agent-1", keyType: undefined },
      { agentUserId: undefined, keyType: "is_internal" },
    ]);
  });

  it("has no write: spending a reader is never a REST call", async () => {
    const app = appAs({});
    for (const path of [
      "/library/readWith",
      "/library/readers",
      "/library/retryMedia",
    ]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemIds: [ITEM],
          readerId: "capture_social_post",
        }),
      });
      expect(res.status, path).toBe(404);
    }
    expect(h.ran).toEqual([]);
  });

  it("a failed lookup is a 5xx, never 200 with no offers", async () => {
    h.fail = true;
    const res = await appAs({}).request(`/library/readers?groupId=${ITEM}`);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("refuses a query naming neither or both", async () => {
    const app = appAs({});
    expect((await app.request("/library/readers")).status).toBe(400);
    expect(
      (await app.request(`/library/readers?itemId=${ITEM}&groupId=${ITEM}`))
        .status
    ).toBe(400);
  });
});

describe("per-person rate limits on the reader doors", () => {
  it("retryMedia: the person's taps past the limit are TOO_MANY_REQUESTS before the service; another person is untouched", async () => {
    const { LIBRARY_READER_DOOR_LIMITS } =
      await import("../services/library/door-limits.js");
    const max = LIBRARY_READER_DOOR_LIMITS.retryMedia.max;
    const me = caller({ userId: "rate-person-a" });
    for (let i = 0; i < max; i++) await me.retryMedia({ itemId: ITEM });
    const ranBefore = h.ran.length;
    await expect(me.retryMedia({ itemId: ITEM })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(h.ran.length).toBe(ranBefore);
    await expect(
      caller({ userId: "rate-person-b" }).retryMedia({ itemId: ITEM })
    ).resolves.toEqual({ queued: 2 });
  });

  it("readWith has its own limit; readers on tRPC and Hub REST share ONE budget (429 on REST)", async () => {
    const { LIBRARY_READER_DOOR_LIMITS } =
      await import("../services/library/door-limits.js");
    const me = caller({ userId: "rate-person-c" });
    for (let i = 0; i < LIBRARY_READER_DOOR_LIMITS.readWith.max; i++) {
      await me.readWith({ itemIds: [ITEM], readerId: "builtin" });
    }
    await expect(
      me.readWith({ itemIds: [ITEM], readerId: "builtin" })
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    const app = appAs({ userId: "rate-person-d" });
    const half = Math.floor(LIBRARY_READER_DOOR_LIMITS.readers.max / 2);
    const viaTrpc = caller({ userId: "rate-person-d" });
    for (let i = 0; i < half; i++) await viaTrpc.readers({ itemId: ITEM });
    for (let i = half; i < LIBRARY_READER_DOOR_LIMITS.readers.max; i++) {
      expect(
        (await app.request(`/library/readers?itemId=${ITEM}`)).status
      ).toBe(200);
    }
    expect((await app.request(`/library/readers?itemId=${ITEM}`)).status).toBe(
      429
    );
    await expect(viaTrpc.readers({ itemId: ITEM })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });
});

describe("the whole Library's waiting items (`waiting: true`)", () => {
  it("readers / readWith accept `waiting` alone and hand it to the service; with a target too it is refused", async () => {
    h.ran.length = 0;
    h.args.length = 0;
    const me = caller({ userId: "waiting-person" });
    await me.readers({ waiting: true });
    await me.readWith({ waiting: true, readerId: "builtin" });
    expect(h.args).toEqual([
      expect.objectContaining({ userId: "waiting-person", waiting: true }),
      expect.objectContaining({
        userId: "waiting-person",
        waiting: true,
        readerId: "builtin",
      }),
    ]);
    h.ran.length = 0;
    await expect(
      me.readers({ waiting: true, itemId: ITEM })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      me.readWith({ waiting: true, groupId: ITEM, readerId: "builtin" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.ran).toEqual([]);
  });

  it("an agent may see the offers but never read the whole Library", async () => {
    h.ran.length = 0;
    await expect(
      caller({ agentUserId: "agent-1" }).readWith({
        waiting: true,
        readerId: "builtin",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.ran).toEqual([]);
  });

  it("Hub REST: `?waiting=true` reaches the service", async () => {
    h.args.length = 0;
    const res = await appAs({ userId: "waiting-rest" }).request(
      "/library/readers?waiting=true"
    );
    expect(res.status).toBe(200);
    expect(h.args[0]).toMatchObject({ waiting: true });
  });
});
