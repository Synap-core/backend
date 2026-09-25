/**
 * Hub REST documents — no silent drops (documents plan W0 #6).
 *
 * The defects this pins, each a request field the door accepted and ignored:
 *  1. POST /documents never forwarded `url` or `idempotencyKey`, so
 *     `synap doc reference` created an empty authored doc instead of a
 *     reference, and retries could not dedupe on the caller's key.
 *  2. POST /documents never honoured `entityId`: skills taught it, the door
 *     dropped it, and the document floated unattached.
 *  3. PATCH /documents/:id accepted `title` alongside `content` and dropped it.
 *
 * Driven through the real route and the real attach helper; only the tRPC
 * callers and the entities router are stubbed.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createInputs: [] as Array<Record<string, unknown>>,
  createResult: {} as Record<string, unknown>,
  proposalInputs: [] as Array<Record<string, unknown>>,
  entityUpdates: [] as Array<Record<string, unknown>>,
}));

vi.mock("./_shared.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
  errCode: () => undefined,
  httpStatusForTrpcError: () => 500,
  verifyWorkspaceReadAccess: async () => true,
  resolveActorId: async () => ({ ok: true }),
  resolveActingContext: async (
    c: { get: (k: string) => unknown },
    body: { workspaceId?: string }
  ) => ({
    ok: true as const,
    userId: c.get("userId") as string,
    workspaceId: body.workspaceId ?? null,
    role: "owner",
  }),
  getCaller: async () => ({
    documents: {
      createDocument: async (input: Record<string, unknown>) => {
        h.createInputs.push(input);
        return h.createResult;
      },
      getDocument: async () => ({ document: { content: "old body" } }),
      createDocumentProposal: async (input: Record<string, unknown>) => {
        h.proposalInputs.push(input);
        return { status: "proposed", proposalId: "prop-1" };
      },
    },
  }),
}));

vi.mock("../confine-workspace.js", () => ({
  getConfinedWorkspace: (_c: unknown, ws: string | null) => ws,
}));

vi.mock("../utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));

vi.mock("../../entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      update: async (input: Record<string, unknown>) => {
        h.entityUpdates.push(input);
        return { status: "updated" };
      },
    }),
  },
}));

import { registerDocumentsRoutes } from "./documents.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "44444444-4444-4444-8444-444444444444";
const ENTITY = "55555555-5555-4555-8555-555555555555";
const DOC = "66666666-6666-4666-8666-666666666666";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.write", "hub-protocol.read"]);
    c.set("userId", USER);
    await next();
  });
  registerDocumentsRoutes(app);
  return app;
}

function json(method: string, body: Record<string, unknown>) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(() => {
  h.createInputs.length = 0;
  h.proposalInputs.length = 0;
  h.entityUpdates.length = 0;
  h.createResult = {
    id: DOC,
    documentId: DOC,
    status: "created",
    ackState: "applied",
  };
});

describe("POST /documents — forwards what it accepts", () => {
  it("forwards url and idempotencyKey to createDocument", async () => {
    const res = await buildApp().request(
      "/documents",
      json("POST", {
        userId: USER,
        workspaceId: WS,
        title: "Spec",
        url: "https://example.com/spec.pdf",
        idempotencyKey: "key-1",
      })
    );
    expect(res.status).toBe(200);
    expect(h.createInputs).toHaveLength(1);
    expect(h.createInputs[0]).toMatchObject({
      url: "https://example.com/spec.pdf",
      idempotencyKey: "key-1",
    });
  });

  it("attaches entityId through a governed entities.update and reports it", async () => {
    const res = await buildApp().request(
      "/documents",
      json("POST", {
        userId: USER,
        workspaceId: WS,
        title: "Notes",
        content: "# Notes",
        entityId: ENTITY,
      })
    );
    expect(res.status).toBe(200);
    expect(h.entityUpdates).toEqual([
      expect.objectContaining({ id: ENTITY, documentId: DOC }),
    ]);
    const body = (await res.json()) as { attached?: Record<string, unknown> };
    expect(body.attached).toMatchObject({
      entityId: ENTITY,
      documentId: DOC,
      status: "updated",
    });
  });

  it("does not attach a proposed document, and says so", async () => {
    h.createResult = { documentId: DOC, status: "proposed", proposalId: "p" };
    const res = await buildApp().request(
      "/documents",
      json("POST", {
        userId: USER,
        workspaceId: WS,
        title: "Notes",
        entityId: ENTITY,
      })
    );
    expect(h.entityUpdates).toHaveLength(0);
    const body = (await res.json()) as { attached?: Record<string, unknown> };
    expect(body.attached).toMatchObject({
      entityId: ENTITY,
      status: "skipped",
    });
  });

  it("without entityId, touches no entity and adds no attached field", async () => {
    const res = await buildApp().request(
      "/documents",
      json("POST", { userId: USER, workspaceId: WS, title: "Loose" })
    );
    expect(h.entityUpdates).toHaveLength(0);
    expect(await res.json()).not.toHaveProperty("attached");
  });
});

describe("PATCH /documents/:id — a title is refused, never dropped", () => {
  it("returns 400 for title + content and files no proposal", async () => {
    const res = await buildApp().request(
      `/documents/${DOC}`,
      json("PATCH", { userId: USER, title: "New name", content: "# New" })
    );
    expect(res.status).toBe(400);
    expect(h.proposalInputs).toHaveLength(0);
  });

  it("content alone still files the full-replacement edit (patch door alias)", async () => {
    const res = await buildApp().request(
      `/documents/${DOC}`,
      json("PATCH", { userId: USER, content: "# New" })
    );
    expect(res.status).not.toBe(400);
    expect(h.proposalInputs).toEqual([
      expect.objectContaining({
        documentId: DOC,
        proposedContent: "# New",
      }),
    ]);
  });
});
