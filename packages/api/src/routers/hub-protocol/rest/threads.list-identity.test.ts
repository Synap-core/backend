/**
 * GET /threads — `?userId` is bound by `mayActAsUser`.
 *
 * The handler fed `query.userId` straight into `channelVisibilityWhere` and
 * `getUserAccessibleWorkspaceIds`, so any hub-read key could list another
 * user's threads. The guard runs before the first DB read.
 *
 * Harness mirrors `__tests__/threads-message-authz.test.ts`: only `db` is
 * replaced (importOriginal keeps every other export real) by a chainable fake
 * that answers `[]` and COUNTS reads. Both directions are asserted — a refused
 * caller never reads, an allowed caller does — so a guard that refused
 * everyone would fail here too.
 *
 * Does NOT cover: which rows an allowed caller sees (that is
 * `channelVisibilityWhere`'s contract, tested with it).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const VICTIM = "0bbbbbbb-0000-4000-8000-000000000002";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";

const state = { reads: 0 };

function selectChain(): any {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    as: () => chain,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(res, rej),
  };
  return chain;
}

const fakeDb: any = {
  select: (..._args: unknown[]) => {
    state.reads += 1;
    return selectChain();
  },
  selectDistinct: (..._args: unknown[]) => {
    state.reads += 1;
    return selectChain();
  },
  query: {},
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: fakeDb };
});

const { registerThreadsRoutes } = await import("./threads.js");

function makeApp(vars: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(vars)) c.set(k as never, v as never);
    await next();
  });
  registerThreadsRoutes(app as never);
  return app;
}

const readKey = {
  userId: HUMAN,
  scopes: ["hub-protocol.read"],
  apiKeyId: "key-1",
  agentUserId: AGENT,
};

beforeEach(() => {
  state.reads = 0;
});

describe("GET /threads — ?userId bound by mayActAsUser", () => {
  it("a hub_inbound key naming another user → 403, never reads the db", async () => {
    const res = await makeApp({ ...readKey, keyType: "hub_inbound" }).request(
      `/threads?userId=${VICTIM}`
    );
    expect(res.status).toBe(403);
    expect(state.reads).toBe(0);
  });

  it("naming the authenticated user itself passes the guard", async () => {
    const res = await makeApp({ ...readKey, keyType: "hub_inbound" }).request(
      `/threads?userId=${HUMAN}`
    );
    expect(res.status).not.toBe(403);
    expect(state.reads).toBeGreaterThan(0);
  });

  it("a system key may still name another user", async () => {
    const res = await makeApp({ ...readKey, keyType: "system" }).request(
      `/threads?userId=${VICTIM}`
    );
    expect(res.status).not.toBe(403);
    expect(state.reads).toBeGreaterThan(0);
  });
});
