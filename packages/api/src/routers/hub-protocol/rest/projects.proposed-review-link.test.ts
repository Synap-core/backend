/**
 * Hub REST — a governed project write that PROPOSES returns its review link.
 *
 * POST, PATCH and DELETE /projects answered 202 with `{status, proposalId}`
 * only, dropping the gate's `reviewUrl`/`reviewPath`. Every other governed
 * route forwards them (e.g. rest/cell-instances.ts), so an agent here had to
 * build the link itself.
 *
 * DB-free door test: the REAL handlers run; the permission gate is mocked to
 * propose, so nothing past the 202 branch executes. PATCH loads the project on
 * the visibility floor BEFORE the gate (so a foreign id 404s instead of filing
 * an unappliable proposal) — that one read is stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const USER_ID = "e418d146-0000-4000-8000-000000000001";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

const checkPermissionOrProposeMock = vi.fn();

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: (...args: unknown[]) =>
    checkPermissionOrProposeMock(...args),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import { registerProjectsRoutes } from "./projects.js";
import type { HubHono, HubVariables } from "./_shared.js";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerProjectsRoutes(app);
  return app;
}

const json = (method: string, body?: Record<string, unknown>) => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(db.query.projects, "findFirst").mockResolvedValue({
    id: PROJECT_ID,
    workspaceId: null,
  } as never);
  checkPermissionOrProposeMock.mockResolvedValue({
    proposalId: "prop-1",
    summary: "Create project",
    reviewPath: "/open/proposal/prop-1",
    reviewUrl: "https://pod.example/open/proposal/prop-1",
  });
});

describe("/projects — a proposed write carries its review link", () => {
  const cases: Array<[string, string, string, Record<string, unknown>?]> = [
    ["POST", "/projects", "POST", { name: "Atlas" }],
    ["PATCH", `/projects/${PROJECT_ID}`, "PATCH", { name: "Atlas 2" }],
    ["DELETE", `/projects/${PROJECT_ID}`, "DELETE", undefined],
  ];

  it.each(cases)(
    "%s returns reviewUrl + reviewPath on 202",
    async (_l, path, method, body) => {
      const res = await buildApp().request(path, json(method, body));
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: "proposed",
        proposalId: "prop-1",
        reviewPath: "/open/proposal/prop-1",
        reviewUrl: "https://pod.example/open/proposal/prop-1",
      });
    }
  );

  it("derives the review link when the gate supplied none", async () => {
    // The product rule is that a proposal ALWAYS carries its review link, so a
    // gate that returned only a proposalId no longer leaves the agent without
    // one: `jsonGoverned` fills it from the shared `/open/<id>` builder
    // (`openLink`) — never a second URL rule. `reviewPath` stays gate-only.
    checkPermissionOrProposeMock.mockResolvedValueOnce({
      proposalId: "prop-2",
    });
    const res = await buildApp().request(
      `/projects/${PROJECT_ID}`,
      json("DELETE")
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: "proposed",
      proposalId: "prop-2",
      reviewUrl: "/open/prop-2",
    });
  });

  it("PATCH on a project the caller cannot see is 404 and never reaches the gate", async () => {
    vi.spyOn(db.query.projects, "findFirst").mockResolvedValueOnce(
      undefined as never
    );
    const res = await buildApp().request(
      `/projects/${PROJECT_ID}`,
      json("PATCH", { name: "Atlas 3" })
    );
    expect(res.status).toBe(404);
    expect(checkPermissionOrProposeMock).not.toHaveBeenCalled();
  });

  it("PATCH forwards reasoning, phase and targetDate to the gate", async () => {
    await buildApp().request(
      `/projects/${PROJECT_ID}`,
      json("PATCH", {
        phase: "wedge A",
        targetDate: "2026-12-15",
        reasoning: "why",
      })
    );
    const arg = checkPermissionOrProposeMock.mock.calls[0]?.[0] as {
      reasoning?: string;
      data: Record<string, unknown>;
    };
    expect(arg.reasoning).toBe("why");
    expect(arg.data.phase).toBe("wedge A");
    expect(arg.data.targetDate).toBeInstanceOf(Date);
    expect(arg.data).not.toHaveProperty("reasoning");
  });
});
