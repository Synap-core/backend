/**
 * Hub REST — POST/DELETE /relations and POST /capture/graph attribute an
 * agent-key write to the KEY's agent, and /relations classifies errors.
 *
 * THE INCIDENT (live pod, 2026-09-13): a Raycast agent key created `relates_to`
 * edges that landed `created_by_kind=human`, `agentUserId=null`. The routes
 * read the agent only from `body.agentUserId`; a key that did not echo its own
 * id ran as the human — ungoverned and unattributed. /capture/graph never
 * forwarded an agent at all, so an agent-key graph never reached agent mode.
 *
 * DB-free door test (same harness as capture.structure-agent-origin.test.ts):
 * the REAL handlers run; `_shared.js` keeps its real `httpStatusForTrpcError`
 * and the downstream caller / core are spied so the test reads what governance
 * actually receives.
 *
 * NOT covered: the tRPC procedures' own governance (their suites own it).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const USER_ID = "e418d146-0000-4000-8000-000000000001";
const AGENT_ID = "0e0403a8-0000-4000-8000-000000000002";
const BODY_AGENT_ID = "0e0403a8-0000-4000-8000-000000000003";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";

const resolveActorIdMock = vi.fn();
const getCallerMock = vi.fn();
const createRelationMock = vi.fn();
const deleteRelationMock = vi.fn();
const submitCaptureGraphMock = vi.fn();

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    resolveActingContext: async () => ({
      ok: true,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      role: "editor",
    }),
    confineWorkspaceOrForbidden: (_c: unknown, ws: string | undefined) => ({
      ok: true,
      workspaceId: ws,
    }),
    resolveActorId: (...args: unknown[]) => resolveActorIdMock(...args),
    getCaller: (...args: unknown[]) => getCallerMock(...args),
  };
});

vi.mock(
  "../../../services/capture-agent/submit-capture-graph.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      submitCaptureGraph: (...args: unknown[]) =>
        submitCaptureGraphMock(...args),
    };
  }
);

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerRelationsRoutes } from "./relations.js";
import { registerCaptureRoutes } from "./capture.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(agentUserId?: string): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (agentUserId)
      (c as unknown as { set: (k: string, v: unknown) => void }).set(
        "agentUserId",
        agentUserId
      );
    await next();
  });
  registerRelationsRoutes(app);
  registerCaptureRoutes(app);
  return app;
}

const json = (method: string, body: Record<string, unknown>) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const relationBody = {
  workspaceId: WORKSPACE_ID,
  sourceEntityId: SOURCE_ID,
  targetEntityId: TARGET_ID,
  type: "relates_to",
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveActorIdMock.mockImplementation(
    async (agentUserId: string | undefined, userId: string) => ({
      actorId: agentUserId ?? userId,
    })
  );
  createRelationMock.mockResolvedValue({ status: "created", id: "rel-1" });
  deleteRelationMock.mockResolvedValue({ ok: true });
  getCallerMock.mockResolvedValue({
    relations: {
      createRelation: createRelationMock,
      deleteRelation: deleteRelationMock,
    },
  });
  submitCaptureGraphMock.mockResolvedValue({
    proposalId: "p-1",
    entityCount: 1,
    relationCount: 0,
  });
});

describe("POST /relations — agent attribution", () => {
  it("an agent key with NO body agentUserId is governed as its own agent", async () => {
    const res = await buildApp(AGENT_ID).request(
      "/relations",
      json("POST", relationBody)
    );
    expect(res.status).toBe(200);
    expect(resolveActorIdMock).toHaveBeenCalledWith(AGENT_ID, USER_ID);
    expect(getCallerMock.mock.calls[0][1]).toMatchObject({ userId: AGENT_ID });
    expect(createRelationMock.mock.calls[0][0]).toMatchObject({
      userId: USER_ID,
      agentUserId: AGENT_ID,
    });
  });

  it("a body agentUserId still wins over the key's agent", async () => {
    await buildApp(AGENT_ID).request(
      "/relations",
      json("POST", { ...relationBody, agentUserId: BODY_AGENT_ID })
    );
    expect(createRelationMock.mock.calls[0][0].agentUserId).toBe(BODY_AGENT_ID);
  });

  it("a human session (no agent anywhere) stays the human", async () => {
    await buildApp().request("/relations", json("POST", relationBody));
    expect(resolveActorIdMock).toHaveBeenCalledWith(undefined, USER_ID);
    expect(createRelationMock.mock.calls[0][0]).not.toHaveProperty(
      "agentUserId"
    );
  });
});

describe("DELETE /relations/:id — agent attribution", () => {
  it("falls back to the key's agent and validates it through resolveActorId", async () => {
    const res = await buildApp(AGENT_ID).request(
      "/relations/rel-1",
      json("DELETE", { workspaceId: WORKSPACE_ID })
    );
    expect(res.status).toBe(200);
    expect(resolveActorIdMock).toHaveBeenCalledWith(AGENT_ID, USER_ID);
    expect(deleteRelationMock.mock.calls[0][0]).toMatchObject({
      agentUserId: AGENT_ID,
    });
  });

  it("an agent the caller cannot act as is refused before any delete", async () => {
    resolveActorIdMock.mockResolvedValueOnce({ error: "not authorized" });
    const res = await buildApp().request(
      "/relations/rel-1",
      json("DELETE", { workspaceId: WORKSPACE_ID, agentUserId: BODY_AGENT_ID })
    );
    expect(res.status).toBe(400);
    expect(deleteRelationMock).not.toHaveBeenCalled();
  });
});

describe("/relations — TRPCError codes map to HTTP status", () => {
  const cases: Array<[string, unknown, number]> = [
    [
      "NOT_FOUND",
      new TRPCError({ code: "NOT_FOUND", message: "endpoint unavailable" }),
      404,
    ],
    ["BAD_REQUEST", new TRPCError({ code: "BAD_REQUEST", message: "x" }), 400],
    ["FORBIDDEN", new TRPCError({ code: "FORBIDDEN", message: "x" }), 403],
    ["unknown", new Error("boom"), 500],
  ];

  it.each(cases)("POST %s", async (_label, err, status) => {
    createRelationMock.mockRejectedValueOnce(err);
    const res = await buildApp(AGENT_ID).request(
      "/relations",
      json("POST", relationBody)
    );
    expect(res.status).toBe(status);
  });

  it.each(cases)("DELETE %s", async (_label, err, status) => {
    deleteRelationMock.mockRejectedValueOnce(err);
    const res = await buildApp(AGENT_ID).request(
      "/relations/rel-1",
      json("DELETE", { workspaceId: WORKSPACE_ID })
    );
    expect(res.status).toBe(status);
  });
});

describe("POST /capture/graph — agent attribution", () => {
  const graphBody = {
    workspaceId: WORKSPACE_ID,
    entities: [{ ref: "a", profileSlug: "note", title: "Alpha" }],
  };

  it("an agent key reaches the core in AGENT mode (agentUserId forwarded)", async () => {
    const res = await buildApp(AGENT_ID).request(
      "/capture/graph",
      json("POST", graphBody)
    );
    expect(res.status).toBe(200);
    expect(resolveActorIdMock).toHaveBeenCalledWith(AGENT_ID, USER_ID);
    expect(submitCaptureGraphMock.mock.calls[0][0]).toMatchObject({
      userId: USER_ID,
      agentUserId: AGENT_ID,
    });
  });

  it("a human session stays on the pending (non-agent) path", async () => {
    await buildApp().request("/capture/graph", json("POST", graphBody));
    expect(submitCaptureGraphMock.mock.calls[0][0]).not.toHaveProperty(
      "agentUserId"
    );
  });

  it("a key agent the caller cannot act as is refused before the core runs", async () => {
    resolveActorIdMock.mockResolvedValueOnce({ error: "not authorized" });
    const res = await buildApp(AGENT_ID).request(
      "/capture/graph",
      json("POST", graphBody)
    );
    expect(res.status).toBe(400);
    expect(submitCaptureGraphMock).not.toHaveBeenCalled();
  });
});
