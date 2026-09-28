/**
 * `synap_set_workspace_focus` SERVES the space brief — DB-independent (the
 * DB-backed `__tests__/workspace-focus.test.ts` needs Postgres).
 *
 * Why: the focus reply used to say only "Focused on Brand Library", and the
 * agent went on to file brand assets as generic `file` entities. The brief's
 * CONTENT is pinned in `space-brief.test.ts`; this pins that the reply
 * CARRIES it, built for the RESOLVED workspace with the caller's own
 * caller/scopes — and that clearing a focus carries none.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  briefCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  getUserMemberWorkspaceIds: async () => ["ws-brand", "ws-crm"],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const rows = [
    { id: "ws-brand", name: "Brand Library" },
    { id: "ws-crm", name: "CRM" },
  ];
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    },
  };
});

vi.mock("../../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<
    typeof import("../../../services/agent-identity-service.js")
  >()),
  setAgentFocusWorkspace: async () => "agent" as const,
}));

vi.mock("../../../services/discover/space-brief.js", () => ({
  buildSpaceBrief: async (p: Record<string, unknown>) => {
    h.briefCalls.push(p);
    return { workspaceId: p.workspaceId, name: "Brand Library", more: "m" };
  },
}));

import { workspaceHandlers } from "./workspace.js";
import type { McpToolContext } from "./shared.js";

const CALLER = { marker: "caller" } as unknown as McpToolContext["caller"];

const focus = async (workspace: string) => {
  const res = await workspaceHandlers.synap_set_workspace_focus!({
    toolName: "synap_set_workspace_focus",
    args: { workspace },
    userId: "u1",
    agentUserId: "agent-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    caller: CALLER,
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  } as McpToolContext);
  const block = res.content?.[0] as { text: string };
  return JSON.parse(block.text) as Record<string, unknown>;
};

beforeEach(() => {
  h.briefCalls = [];
});

describe("synap_set_workspace_focus serves the space brief", () => {
  it("a focused reply carries the brief of the RESOLVED workspace", async () => {
    const reply = await focus("brand");
    expect(reply.status).toBe("focused");
    expect(reply.workspaceId).toBe("ws-brand");
    expect(reply.brief).toEqual({
      workspaceId: "ws-brand",
      name: "Brand Library",
      more: "m",
    });
    expect(h.briefCalls).toHaveLength(1);
    expect(h.briefCalls[0]).toMatchObject({
      workspaceId: "ws-brand",
      userId: "u1",
      scopes: ["mcp.read", "mcp.write"],
    });
    expect(h.briefCalls[0]!.caller).toBe(CALLER);
  });

  it("clearing the focus carries no brief", async () => {
    const reply = await focus("none");
    expect(reply.status).toBe("cleared");
    expect(reply).not.toHaveProperty("brief");
    expect(h.briefCalls).toHaveLength(0);
  });
});
