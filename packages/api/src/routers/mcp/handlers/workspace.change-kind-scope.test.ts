/**
 * `synap_change_kind_scope` (D13) — the REAL handler forwards to
 * `changeKindScope` with the key's acting identity, and narrows the model's
 * args (an off-enum scope never reaches the service as a value). The service
 * (its gate, its owner/admin approval rule) is the only thing replaced; it has
 * its own suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{
    actor: Record<string, unknown>;
    input: Record<string, unknown>;
  }>,
}));

vi.mock("../../../services/profiles/change-kind-scope.js", () => ({
  changeKindScope: async (
    actor: Record<string, unknown>,
    input: Record<string, unknown>
  ) => {
    h.calls.push({ actor, input });
    return {
      status: "proposed",
      proposalId: "p-1",
      proposalType: "change_scope",
      message: "m",
    };
  },
}));

import { workspaceHandlers } from "./workspace.js";
import type { McpToolContext } from "./shared.js";

const PROFILE = "88888888-8888-4888-8888-888888888888";
const WS_B = "99999999-9999-4999-8999-999999999999";

const run = (
  args: Record<string, unknown>,
  scopes = ["mcp.read", "mcp.write"]
) =>
  workspaceHandlers.synap_change_kind_scope!({
    toolName: "synap_change_kind_scope",
    args,
    userId: "u1",
    agentUserId: "agent-1",
    sessionId: "s-1",
    keyType: "agent",
    keyWorkspaceId: null,
    apiKeyScopes: scopes,
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  } as McpToolContext);

const parse = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

beforeEach(() => {
  h.calls = [];
});

describe("synap_change_kind_scope", () => {
  it("forwards the rescope with the key's acting identity; the proposal comes back", async () => {
    const out = parse(
      await run({
        profileId: PROFILE,
        scope: "shared",
        allowedWorkspaceIds: [WS_B, 42],
        entityScope: "pod",
        reasoning: "Brand needs this kind",
      })
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.actor).toEqual({
      userId: "u1",
      scopes: ["mcp.read", "mcp.write"],
      agentUserId: "agent-1",
      sessionId: "s-1",
      keyType: "agent",
      keyWorkspaceId: null,
    });
    expect(h.calls[0]!.input).toEqual({
      profileId: PROFILE,
      scope: "shared",
      allowedWorkspaceIds: [WS_B],
      entityScope: "pod",
      workspaceId: undefined,
      reasoning: "Brand needs this kind",
    });
    expect(out).toMatchObject({ status: "proposed", proposalId: "p-1" });
  });

  it("an off-enum scope is dropped, not forwarded", async () => {
    await run({ profileId: PROFILE, scope: "everywhere", entityScope: "pod" });
    expect(h.calls[0]!.input.scope).toBeUndefined();
  });

  it("no profileId → an error answer, and the service is never called", async () => {
    expect(parse(await run({ scope: "shared" })).error).toMatch(/profileId/);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a key without mcp.write", async () => {
    await expect(run({ profileId: PROFILE }, ["mcp.read"])).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
});
