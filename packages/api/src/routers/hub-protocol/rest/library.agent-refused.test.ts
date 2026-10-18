/**
 * POST /library/add — nothing an agent sends lands in the Library
 * (CAPTURE_LIBRARY_PLAN §1, founder 2026-10-13). An agent key or the IS's
 * internal key is refused with AGENT_USE_CAPTURE BEFORE the service runs; a
 * person's key reaches the add service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({
  added: [] as unknown[],
  proposed: [] as unknown[],
  group: "00000000-0000-4000-8000-0000000000aa",
}));

vi.mock("../../../services/library/organize.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../services/library/organize.js")
    >();
  return {
    ...actual,
    // The real refusal of a person, then a recorded proposal for an agent.
    proposeLibraryOrganize: async (
      args: Parameters<typeof actual.proposeLibraryOrganize>[0]
    ) => {
      h.proposed.push(args);
      return actual.proposeLibraryOrganize({
        ...args,
        database: {
          select: () => ({
            from: () => ({ where: async () => [{ id: h.group, name: "G" }] }),
          }),
        } as never,
        gate: (async () => ({
          granted: false,
          proposalId: "p-1",
          reviewUrl: "https://pod/open/p-1",
        })) as never,
      });
    },
  };
});
const GROUP = h.group;

vi.mock("../../../services/library/add.js", () => ({
  addToLibrary: async (args: unknown) => {
    h.added.push(args);
    return { runId: "r", staged: [], refused: [] };
  },
  startKeptItemReads: async () => undefined,
}));

import { registerLibraryRoutes } from "./library.js";

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

const add = (app: OpenAPIHono) =>
  app.request("/library/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ kind: "url", url: "https://example.com" }],
    }),
  });

beforeEach(() => {
  h.added.length = 0;
});

describe("POST /library/add", () => {
  it("refuses an agent key and points it at synap_capture", async () => {
    const res = await add(appAs({ agentUserId: "agent-1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "AGENT_USE_CAPTURE" });
    expect(h.added).toEqual([]);
  });

  it("refuses the IS's internal key", async () => {
    const res = await add(appAs({ keyType: "is_internal" }));
    expect(res.status).toBe(403);
    expect(h.added).toEqual([]);
  });

  it("lets a person keep (never Read now from this door)", async () => {
    const res = await add(appAs({}));
    expect(res.status).toBe(200);
    expect(h.added).toHaveLength(1);
    expect(
      h.added[0] as { userId: string; request: { readNow: boolean } }
    ).toMatchObject({
      userId: "person-1",
      request: { readNow: false },
    });
  });
});

describe("POST /library/propose — an agent proposes organisation", () => {
  const propose = (app: OpenAPIHono, body: unknown) =>
    app.request("/library/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("an agent key gets a PROPOSAL (nothing applied), with its identity threaded", async () => {
    const res = await propose(appAs({ agentUserId: "agent-1" }), {
      ops: [{ op: "group.build", groupId: GROUP }],
      reasoning: "ready",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "proposed",
      proposalId: "p-1",
      reviewUrl: "https://pod/open/p-1",
    });
    expect(h.proposed[0]).toMatchObject({
      userId: "person-1",
      caller: { agentUserId: "agent-1" },
      ops: [{ op: "group.build", groupId: GROUP }],
    });
  });

  it("a person is refused (400: they organise directly); a content op is not an op (400)", async () => {
    expect(
      (
        await propose(appAs({}), {
          ops: [{ op: "group.build", groupId: GROUP }],
        })
      ).status
    ).toBe(400);
    expect(
      (
        await propose(appAs({ agentUserId: "agent-1" }), {
          ops: [{ op: "item.delete", itemIds: [GROUP] }],
        })
      ).status
    ).toBe(400);
  });
});
