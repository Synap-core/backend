/**
 * Hub REST — the document patch door's routes (W4b).
 *
 *  - `POST /documents/:id/patch` forwards the ops, base and embed opt-in to hub
 *    `patchDocument` (the door), refuses malformed ops at the edge (400, the
 *    door never called), and maps the door's refusals to their statuses (a
 *    moved document is 409, not a 500).
 *  - `POST /documents/proposals` is an ALIAS: it forwards the replacement and
 *    the base, and no longer carries the decorative `changes[]` /
 *    `originalContent` an agent used to supply.
 *  - `GET /documents/:id?format=readable` reaches the read projection.
 *
 * Driven through the real routes; the tRPC caller is stubbed.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  patchInputs: [] as Array<Record<string, unknown>>,
  proposalInputs: [] as Array<Record<string, unknown>>,
  getInputs: [] as Array<Record<string, unknown>>,
  patchThrows: null as null | { code: string; message: string },
}));

vi.mock("./_shared.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./_shared.js");
  return {
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    hasScope: (scopes: string[], scope: string) => scopes.includes(scope),
    errCode: actual.errCode,
    httpStatusForTrpcError: actual.httpStatusForTrpcError,
    resolveActorId: async () => ({ ok: true }),
    resolveActingContext: async (c: { get: (k: string) => unknown }) => ({
      ok: true as const,
      userId: c.get("userId") as string,
      workspaceId: null,
      role: "owner",
    }),
    getCaller: async () => ({
      documents: {
        patchDocument: async (input: Record<string, unknown>) => {
          h.patchInputs.push(input);
          if (h.patchThrows)
            throw Object.assign(
              new Error(h.patchThrows.message),
              h.patchThrows
            );
          return {
            status: "proposed",
            proposalId: "prop-1",
            documentId: input.documentId,
          };
        },
        createDocumentProposal: async (input: Record<string, unknown>) => {
          h.proposalInputs.push(input);
          return { status: "proposed", proposalId: "prop-2" };
        },
        getDocument: async (input: Record<string, unknown>) => {
          h.getInputs.push(input);
          return { document: { id: input.documentId, revision: 4 } };
        },
      },
    }),
  };
});

vi.mock("../confine-workspace.js", () => ({
  getConfinedWorkspace: (_c: unknown, ws: string | null) => ws,
}));

import { registerDocumentsRoutes } from "./documents.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
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

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  h.patchInputs = [];
  h.proposalInputs = [];
  h.getInputs = [];
  h.patchThrows = null;
});

describe("POST /documents/:id/patch", () => {
  it("forwards ops, base and the embed opt-in to the door", async () => {
    const ops = [
      { op: "replace_text", old: "Friday", new: "Monday" },
      { op: "upsert_section", id: "risks", title: "Risks", body: "None." },
    ];
    const res = await buildApp().request(
      `/documents/${DOC}/patch`,
      json("POST", {
        userId: USER,
        baseRevision: 4,
        ops,
        allowRemovingEmbeds: true,
        reasoning: "why",
      })
    );
    expect(res.status).toBe(202);
    expect(h.patchInputs).toEqual([
      {
        documentId: DOC,
        baseRevision: 4,
        ops,
        allowRemovingEmbeds: true,
        reasoning: "why",
      },
    ]);
  });

  it("refuses malformed ops at the edge — the door is never called", async () => {
    for (const ops of [
      [],
      [{ op: "delete_everything" }],
      [{ op: "replace_text", old: "", new: "x" }],
    ]) {
      const res = await buildApp().request(
        `/documents/${DOC}/patch`,
        json("POST", { userId: USER, ops })
      );
      expect(res.status).toBe(400);
    }
    expect(h.patchInputs).toEqual([]);
  });

  it("a moved document answers 409 with the door's message; a person's section 403", async () => {
    h.patchThrows = {
      code: "CONFLICT",
      message: "This document changed after the edit was drafted",
    };
    let res = await buildApp().request(
      `/documents/${DOC}/patch`,
      json("POST", {
        userId: USER,
        baseRevision: 1,
        ops: [{ op: "append", body: "x" }],
      })
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This document changed after the edit was drafted",
    });
    h.patchThrows = { code: "FORBIDDEN", message: "belongs to a person" };
    res = await buildApp().request(
      `/documents/${DOC}/patch`,
      json("POST", { userId: USER, ops: [{ op: "append", body: "x" }] })
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /documents/proposals — a full-replacement alias", () => {
  it("forwards the replacement + base, never the legacy decorative diff", async () => {
    const res = await buildApp().request(
      "/documents/proposals",
      json("POST", {
        documentId: DOC,
        userId: USER,
        proposedContent: "# New",
        baseRevision: 2,
        changes: [{ op: "replace", range: [0, 3], text: "# New" }],
        originalContent: "# Old",
      })
    );
    expect(res.status).toBe(202);
    expect(h.proposalInputs).toEqual([
      {
        documentId: DOC,
        userId: USER,
        proposedContent: "# New",
        baseRevision: 2,
      },
    ]);
  });
});

describe("GET /documents/:id — the read projection", () => {
  it("forwards format=readable; refuses an unknown format", async () => {
    let res = await buildApp().request(
      `/documents/${DOC}?userId=${USER}&format=readable`
    );
    expect(res.status).toBe(200);
    expect(h.getInputs).toEqual([
      { documentId: DOC, userId: USER, format: "readable" },
    ]);
    res = await buildApp().request(
      `/documents/${DOC}?userId=${USER}&format=pdf`
    );
    expect(res.status).toBe(400);
  });
});
