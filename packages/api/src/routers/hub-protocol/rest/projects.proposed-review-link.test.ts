/**
 * Hub REST — a governed project write that PROPOSES returns its review link.
 *
 * POST, PATCH and DELETE /projects answered 202 with `{status, proposalId}`
 * only, dropping the gate's `reviewUrl`/`reviewPath`. Every other governed
 * route forwards them (e.g. rest/cell-instances.ts), so an agent here had to
 * build the link itself.
 *
 * DB-free door test: the REAL handlers run; the permission gate is mocked to
 * propose, so nothing past the 202 branch executes.
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

  it("omits the link keys when the gate supplied none", async () => {
    checkPermissionOrProposeMock.mockResolvedValueOnce({
      proposalId: "prop-2",
    });
    const res = await buildApp().request(
      `/projects/${PROJECT_ID}`,
      json("DELETE")
    );
    expect(await res.json()).toEqual({
      status: "proposed",
      proposalId: "prop-2",
    });
  });
});
