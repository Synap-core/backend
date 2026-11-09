/**
 * `synap_orient {only: 'handedToYou'}`: the narrow read a worker polls.
 *
 * Why: the whole briefing is over the reply cap (`reply-cap.ts`, 37,416
 * characters on the founder's pod on 2026-11-09), so a capped reply carried
 * no `handedToYou` and the CLI worker stopped. The narrow read answers ONLY
 * the block, from the same `readHandedToYou` the briefing uses, and never
 * builds the briefing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  handedCalls: [] as Array<[string, string]>,
  discoverCalls: 0,
}));

vi.mock("../../../services/discover/start-here.js", () => ({
  readHandedToYou: async (userId: string, agentUserId: string) => {
    h.handedCalls.push([userId, agentUserId]);
    return { count: 1, items: [{ id: "s-1", goal: "g" }] };
  },
}));

vi.mock("../../../services/discover/discover.js", () => ({
  discover: async () => {
    h.discoverCalls++;
    return { startHere: { big: "x".repeat(40_000) } };
  },
}));

import { workspaceHandlers } from "./workspace.js";
import type { McpToolContext } from "./shared.js";

const orient = async (args: Record<string, unknown>, agentUserId?: string) => {
  const res = await workspaceHandlers.synap_orient!({
    toolName: "synap_orient",
    args,
    userId: "u1",
    ...(agentUserId ? { agentUserId } : {}),
    apiKeyScopes: ["mcp.read"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
  } as McpToolContext);
  const block = res.content?.[0] as { text: string };
  return JSON.parse(block.text) as Record<string, unknown>;
};

beforeEach(() => {
  h.handedCalls = [];
  h.discoverCalls = 0;
});

describe("synap_orient only:'handedToYou'", () => {
  it("answers just the block, for the calling agent, without building the briefing", async () => {
    const reply = await orient({ only: "handedToYou" }, "agent-1");
    expect(reply).toEqual({
      handedToYou: { count: 1, items: [{ id: "s-1", goal: "g" }] },
    });
    expect(h.handedCalls).toEqual([["u1", "agent-1"]]);
    expect(h.discoverCalls).toBe(0);
  });

  it("refuses a key that is not an agent, in words", async () => {
    const reply = await orient({ only: "handedToYou" });
    expect(String(reply.error)).toMatch(/needs an agent key/);
    expect(h.handedCalls).toEqual([]);
  });

  it("refuses an unknown part instead of answering the whole briefing", async () => {
    const reply = await orient({ only: "everything" }, "agent-1");
    expect(String(reply.error)).toMatch(/Unknown only 'everything'/);
    expect(h.discoverCalls).toBe(0);
  });

  it("without `only` it is the briefing, as before", async () => {
    await orient({}, "agent-1");
    expect(h.discoverCalls).toBe(1);
  });
});
