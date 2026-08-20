/**
 * Seam test — MCP `synap_run_capability` threads the ambient focus session.
 *
 * `synap_run_capability` is already session-linked at the adapter level (see
 * session-attribution.test.ts — it is NOT on the read-only deny-list, so
 * `resolveSessionHandle` populates `ctx.sessionId` from the verified
 * X-Session-Id). The handler simply never READ it: it destructured
 * `{ toolName, args, userId, apiKeyScopes, agentUserId, requestedWorkspaceId }`
 * and the `capability.run` proposal it produced stored session_id NULL — the
 * same drop measured on the live pod (45/45 NULL).
 *
 * This pins what the handler HANDS to `executeCapability`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "5f3a1c88-1111-4bbb-8ccc-222222222222";
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const calls: any[] = [];

vi.mock("../../../services/capabilities/execute-capability.js", () => ({
  executeCapability: async (input: any) => {
    calls.push(input);
    return { kind: "proposed", proposalId: "prop-1" };
  },
}));

const { capabilityHandlers } = await import("./capability.js");

function ctx(extra: Record<string, unknown> = {}) {
  return {
    toolName: "synap_run_capability",
    args: { verbId: "gmail_send", parameters: { to: "a@b.c" } },
    userId: "user-1",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "agent-1",
    requestedWorkspaceId: WS,
    ...extra,
  } as any;
}

describe("synap_run_capability — session provenance", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("forwards ctx.sessionId to executeCapability", async () => {
    await capabilityHandlers.synap_run_capability!(ctx({ sessionId: SESSION }));
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe(SESSION);
  });

  it("passes null when no session is open (never invents a turn id)", async () => {
    await capabilityHandlers.synap_run_capability!(ctx());
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBeNull();
  });

  it("still threads the acting agent + confined workspace", async () => {
    await capabilityHandlers.synap_run_capability!(ctx({ sessionId: SESSION }));
    expect(calls[0]).toMatchObject({
      verbId: "gmail_send",
      workspaceId: WS,
      userId: "user-1",
      agentUserId: "agent-1",
    });
  });
});
