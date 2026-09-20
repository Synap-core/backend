/**
 * Hub REST — POST /capture/execute relays EVERY advisory routing hint to
 * `capture.execute`, the same set MCP forwards (`captureExecuteRoutingHints`).
 *
 * THE GAP: the codec declared only `aiWorkspaceId/Confidence/Reason`. zod
 * STRIPS undeclared keys, so `aiWorkspaceDecision` (the decision distribution
 * recorded on the route event) and the `aiProject*` suggestion never reached
 * execute — a REST capture recorded less than the same capture through MCP.
 *
 * Drives the REAL route + REAL codec from the wire shape the mapper produces;
 * only the capture caller underneath is stubbed (records its input).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureExecuteRoutingHints } from "@synap-core/types";

const USER_ID = "e418d146-0000-4000-8000-000000000001";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AI_WS = "22222222-2222-4222-8222-222222222222";
const AI_PROJECT = "33333333-3333-4333-8333-333333333333";

const executeMock = vi.fn();

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
  };
});

vi.mock("../../../services/capture-agent/resolve-capture-actor.js", () => ({
  resolveCaptureActorUserId: async () => undefined,
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createHubProtocolCallerContext: async (userId: string) => ({ userId }),
  };
});

vi.mock("../../capture.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    captureRouter: {
      createCaller: () => ({
        execute: (...args: unknown[]) => executeMock(...args),
      }),
    },
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { registerCaptureRoutes } from "./capture.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerCaptureRoutes(app);
  return app;
}

const DECISION = {
  decider: "jev" as const,
  model: "jev-1.13",
  probabilities: { [AI_WS]: 0.8, [WORKSPACE_ID]: 0.15, none: 0.05 },
  candidates: [
    { id: AI_WS, name: "CRM" },
    { id: WORKSPACE_ID, name: "Finance" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  executeMock.mockResolvedValue({ created: [] });
});

describe("POST /capture/execute — routing hints parity with MCP", () => {
  it("every hint the mapper produces reaches execute unchanged", async () => {
    // The wire shape a door builds from a structure result — the real mapper.
    const hints = captureExecuteRoutingHints({
      targetWorkspaceId: AI_WS,
      targetWorkspaceConfidence: 0.8,
      targetWorkspaceReason: "Fits CRM best · Finance next",
      targetWorkspaceDecision: DECISION,
      targetProjectId: AI_PROJECT,
      targetProjectConfidence: 0.7,
      targetProjectReason: "mentions the launch",
    });
    const res = await buildApp().request("/capture/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
        entities: [{ tempId: "t1", profileSlug: "note", title: "Acme deal" }],
        ...hints,
      }),
    });
    expect(res.status).toBe(200);
    const forwarded = executeMock.mock.calls[0]![0] as Record<string, unknown>;
    for (const [key, value] of Object.entries(hints)) {
      expect({ [key]: forwarded[key] }).toEqual({ [key]: value });
    }
    // Non-vacuity: the mapper produced every advisory key.
    expect(Object.keys(hints).sort()).toEqual(
      [
        "aiProjectConfidence",
        "aiProjectId",
        "aiProjectReason",
        "aiWorkspaceConfidence",
        "aiWorkspaceDecision",
        "aiWorkspaceId",
        "aiWorkspaceReason",
      ].sort()
    );
  });

  it("the published OpenAPI schema declares the hints (agents read it)", () => {
    const doc = (buildApp() as OpenAPIHono).getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    const props = (
      doc.components?.schemas?.CaptureExecuteRequest as {
        properties?: Record<string, { properties?: Record<string, unknown> }>;
      }
    )?.properties;
    expect(Object.keys(props ?? {})).toEqual(
      expect.arrayContaining([
        "aiWorkspaceDecision",
        "aiProjectId",
        "aiProjectConfidence",
        "aiProjectReason",
      ])
    );
    expect(Object.keys(props!.aiWorkspaceDecision!.properties ?? {})).toEqual(
      expect.arrayContaining(["decider", "probabilities", "candidates"])
    );
  });

  it("the decision shape is validated at the door (same schema as tRPC execute)", async () => {
    const res = await buildApp().request("/capture/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: WORKSPACE_ID,
        entities: [{ tempId: "t1", profileSlug: "note", title: "x" }],
        aiWorkspaceDecision: { decider: "oracle" },
      }),
    });
    expect(res.status).toBe(400);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe("POST /capture/execute — a domain REFUSAL is not a 500", () => {
  it("the same-name CONFLICT answers 409 and KEEPS its guidance", async () => {
    // Live on 2026-09-20 this returned 500 "An unexpected server error
    // occurred" with the body redacted by the 5xx egress middleware, so the
    // caller lost the one sentence that says what to do. Capturing anything
    // whose title matches an existing entity of that kind hits this.
    // Faithful shape: tRPC throws an Error SUBCLASS carrying `.code` — the
    // handler reads `.message` off an Error, and `errCode` duck-types `.code`
    // (never `instanceof`, which is dead in the bundled build).
    executeMock.mockRejectedValue(
      Object.assign(
        new Error(
          "A company with this name already exists: Acme (abc). Reuse an existing id (enrich / attach facet), or pass forceCreate: true if this is genuinely a different subject."
        ),
        { code: "CONFLICT" }
      )
    );
    const res = await buildApp().request("/capture/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entities: [{ tempId: "t1", profileSlug: "company", title: "Acme" }],
      }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("forceCreate");
  });

  it("an unknown failure still answers 500", async () => {
    executeMock.mockRejectedValue(new Error("boom"));
    const res = await buildApp().request("/capture/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entities: [{ tempId: "t1", profileSlug: "note", title: "x" }],
      }),
    });
    expect(res.status).toBe(500);
  });
});
