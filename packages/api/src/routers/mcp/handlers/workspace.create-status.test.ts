/**
 * `synap_create_workspace` granted reply — `status` is the HONEST outcome
 * (`materializeReportStatus`), never the literal "created": an idempotent
 * re-hit of the same template used to reply `status:"created"` beside
 * `materializeStatus:"reused"`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  created: true,
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
    materializeWorkspaceCore: async () => ({
      status: "created",
      workspaceId: "ws-1",
      dependencies: [],
      created: {
        workspaceId: "ws-1",
        created: h.created,
        outcome: h.created ? "created" : "unchanged",
      },
    }),
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
