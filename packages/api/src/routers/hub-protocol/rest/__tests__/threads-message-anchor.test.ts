/**
 * THREADS MESSAGE DOORS — anchored comments (`metadata.anchor`).
 *
 * The Hub REST append doors take an OPEN metadata record (dispatch stamps
 * `agentType` on it), so the anchor is the one key held to the shared contract
 * (`utils/message-anchor.ts`). Proven at the HANDLER: what reaches the insert,
 * and that a refused anchor writes nothing — on BOTH doors, because a batch
 * that skipped the gate would be a way around the single door.
 *
 * Harness mirrors `threads-message-authz.test.ts`: fake `db`, real everything
 * else except the proposal-visibility SSOT gate, replaced with `importOriginal`.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const OWNER = "0aaaaaaa-0000-4000-8000-000000000001";
const THREAD = "0ddddddd-0000-4000-8000-000000000004";
const PROPOSAL = "0ccccccc-0000-4000-8000-000000000003";

const state = {
  inserted: [] as Record<string, unknown>[],
  channelSessions: [] as Array<{ id: string }>,
};

function selectChain(): any {
  const rows = [{ id: THREAD }];
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return chain;
}
const insertChain = () => ({
  values: async (row: Record<string, unknown>) => {
    state.inserted.push(row);
  },
});
const fakeDb: any = {
  select: () => selectChain(),
  insert: () => insertChain(),
  transaction: async (cb: (tx: any) => Promise<unknown>) =>
    cb({ insert: () => insertChain() }),
  query: {
    focusSessions: { findMany: async () => state.channelSessions },
    proposals: { findFirst: async () => undefined },
  },
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: fakeDb, emitMessageEvent: vi.fn(async () => {}) };
});
vi.mock("../../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: vi.fn(async () => {}),
}));
const visibility = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../../../../utils/proposal-visibility.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertProposalVisibleTo: (...args: unknown[]) => visibility(...args),
  };
});

const { registerThreadsRoutes } = await import("../threads.js");

function makeApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    c.set("userId" as never, OWNER as never);
    await next();
  });
  registerThreadsRoutes(app as never);
  return app;
}
const post = (app: OpenAPIHono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const single = (metadata?: unknown) => ({
  role: "user" as const,
  content: "tighten this title",
  userId: OWNER,
  ...(metadata === undefined ? {} : { metadata }),
});

beforeEach(() => {
  state.inserted = [];
  state.channelSessions = [];
  visibility.mockReset();
  visibility.mockImplementation(async () => {});
});

describe("single door", () => {
  it("persists a visible anchor next to the other metadata keys", async () => {
    const res = await post(
      makeApp(),
      `/threads/${THREAD}/messages`,
      single({
        agentType: "meta",
        anchor: { proposalId: PROPOSAL, opRef: " $rel0 ", contentVersion: 1 },
      })
    );
    expect(res.status).toBe(200);
    expect(state.inserted).toHaveLength(1);
    // The PARSED anchor is stored (trimmed) — what was validated is what lands.
    expect(state.inserted[0].metadata).toEqual({
      agentType: "meta",
      anchor: { proposalId: PROPOSAL, opRef: "$rel0", contentVersion: 1 },
    });
    expect(visibility).toHaveBeenCalledWith(PROPOSAL, OWNER, expect.anything());
  });

  it("refuses an anchor naming a proposal the caller cannot see — nothing written", async () => {
    visibility.mockImplementation(async () => {
      throw new TRPCError({ code: "FORBIDDEN", message: "no" });
    });
    const res = await post(
      makeApp(),
      `/threads/${THREAD}/messages`,
      single({ anchor: { proposalId: PROPOSAL, contentVersion: 0 } })
    );
    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("refuses a malformed anchor (unknown key) with 400 — nothing written", async () => {
    const res = await post(
      makeApp(),
      `/threads/${THREAD}/messages`,
      single({ anchor: { contentVersion: 0, sneaky: true } })
    );
    expect(res.status).toBe(400);
    expect(state.inserted).toHaveLength(0);
  });

  it("metadata without an anchor is stored exactly as sent", async () => {
    await post(
      makeApp(),
      `/threads/${THREAD}/messages`,
      single({ agentType: "meta" })
    );
    expect(state.inserted[0].metadata).toEqual({ agentType: "meta" });
    expect(visibility).not.toHaveBeenCalled();
  });

  it("no metadata ⇒ no metadata key on the row", async () => {
    await post(makeApp(), `/threads/${THREAD}/messages`, single());
    expect("metadata" in state.inserted[0]).toBe(false);
  });
});

describe("batch door", () => {
  it("refuses the WHOLE batch when one item's anchor is not allowed", async () => {
    visibility.mockImplementation(async () => {
      throw new TRPCError({ code: "FORBIDDEN", message: "no" });
    });
    const res = await post(makeApp(), `/threads/${THREAD}/messages.batch`, {
      messages: [
        single(),
        single({ anchor: { proposalId: PROPOSAL, contentVersion: 0 } }),
      ],
    });
    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("stores each allowed anchor on its own row", async () => {
    const res = await post(makeApp(), `/threads/${THREAD}/messages.batch`, {
      messages: [
        single(),
        single({ anchor: { proposalId: PROPOSAL, contentVersion: 2 } }),
      ],
    });
    expect(res.status).toBe(200);
    expect("metadata" in state.inserted[0]).toBe(false);
    expect(state.inserted[1].metadata).toEqual({
      anchor: { proposalId: PROPOSAL, contentVersion: 2 },
    });
  });
});
