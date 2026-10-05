/**
 * `synap_create_workspace` granted reply — `status` is the HONEST outcome
 * (`materializeReportStatus`), never the literal "created": an idempotent
 * re-hit of the same template used to reply `status:"created"` beside
 * `materializeStatus:"reused"`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  created: true,
  verdict: { action: "create" } as Record<string, unknown>,
  verdictArgs: null as null | Record<string, unknown>,
  materialized: 0,
}));

vi.mock("../../../services/workspace-creation-service.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/workspace-creation-service.js")
  >()),
  checkOneSpacePerDomain: async (a: Record<string, unknown>) => {
    h.verdictArgs = a;
    return h.verdict;
  },
}));

vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<typeof import("../../../utils/permission-check.js")>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));

vi.mock(
  "../../../services/workspace-materialization-service.js",
  async (orig) => ({
    ...(await orig<
      typeof import("../../../services/workspace-materialization-service.js")
    >()),
    materializeWorkspaceCore: async () => (
      h.materialized++,
      {
        status: "created",
        workspaceId: "ws-1",
        dependencies: [],
        created: {
          workspaceId: "ws-1",
          created: h.created,
          outcome: h.created ? "created" : "unchanged",
        },
      }
    ),
  })
);

import { workspaceHandlers } from "./workspace.js";
import type { McpToolContext } from "./shared.js";

const create = async () => {
  const res = await workspaceHandlers.synap_create_workspace!({
    toolName: "synap_create_workspace",
    args: { name: "Brand Library", definition: {} },
    userId: "u1",
    agentUserId: "agent-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  } as McpToolContext);
  const block = res.content?.[0] as { text: string };
  return JSON.parse(block.text) as Record<string, unknown>;
};

beforeEach(() => {
  h.created = true;
  h.verdict = { action: "create" };
  h.verdictArgs = null;
  h.materialized = 0;
});

describe("synap_create_workspace — reply status is the outcome", () => {
  it("a new workspace replies created", async () => {
    expect(await create()).toMatchObject({
      status: "created",
      materializeStatus: "created",
      created: true,
    });
  });

  it("an idempotent re-hit replies reused — never status created", async () => {
    h.created = false;
    expect(await create()).toMatchObject({
      status: "reused",
      materializeStatus: "reused",
      created: false,
      workspaceId: "ws-1",
    });
  });
});

describe("synap_create_workspace — one space per domain", () => {
  it("asks the verdict with the agent identity and the requested name", async () => {
    await create();
    expect(h.verdictArgs).toMatchObject({
      userId: "u1",
      agentUserId: "agent-1",
      workspaceName: "Brand Library",
    });
  });

  it("a refused verdict replies the typed `exists` result and materializes nothing", async () => {
    const reply = {
      status: "exists",
      workspaceId: "ws-brand",
      workspaceName: "Brand Library",
      matchedBy: "name",
      guidance: "use it — project_use_workspace + file_into_project",
    };
    h.verdict = { action: "refuse", reply };
    expect(await create()).toEqual(reply);
    expect(h.materialized).toBe(0);
  });

  it("a human note rides on the created reply", async () => {
    const note = { existingWorkspaceId: "ws-brand", guidance: "g" };
    h.verdict = { action: "create", note };
    expect(await create()).toMatchObject({
      status: "created",
      oneSpacePerDomain: note,
    });
    expect(h.materialized).toBe(1);
  });
});
