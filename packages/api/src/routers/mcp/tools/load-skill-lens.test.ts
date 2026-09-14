/**
 * `synap_load_skill` reads skills through the caller's lens (founder decision
 * S2): explicit `workspaceId` first, else the agent's DECLARED focus
 * workspace, else no workspace at all — never a guessed membership.
 *
 * Driven through the real `tools.execute` dispatch (the seam the MCP server
 * calls); only the resolver and the focus read are stubbed, so what is proven
 * is which lens REACHES `resolveSkillContent`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ ref: string; userId: string; opts: unknown }>,
  focus: null as string | null,
  focusReads: 0,
}));

vi.mock("../../../services/capability-briefs/load-skill.js", () => ({
  resolveSkillContent: async (ref: string, userId: string, opts?: unknown) => {
    h.calls.push({ ref, userId, opts });
    return "body";
  },
}));
vi.mock(
  "../../../services/agent-identity-service.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAgentFocusWorkspaceId: async () => {
      h.focusReads++;
      return h.focus;
    },
  })
);
// The door read (`users.agentType`) is not what this file proves — see
// load-skill-door-render.test.ts. Stubbed so no call reaches a real database.
vi.mock("../../../services/capability-briefs/resolve-skill-door.js", () => ({
  resolveSkillDoor: async () => "pod-mcp",
}));

import { tools } from "./index.js";

const WS = "11111111-1111-4111-8111-111111111111";
const FOCUS = "22222222-2222-4222-8222-222222222222";

const run = (args: Record<string, unknown>, agentUserId?: string) =>
  tools.execute(
    "synap_load_skill",
    { ref: "lenses", ...args },
    "u1",
    ["mcp.read"],
    "u1",
    agentUserId
  );

beforeEach(() => {
  h.calls = [];
  h.focus = null;
  h.focusReads = 0;
});

describe("synap_load_skill lens", () => {
  it("passes an explicit workspaceId and does not read focus", async () => {
    h.focus = FOCUS;
    await run({ workspaceId: WS }, "agent-1");
    expect(h.calls).toEqual([
      { ref: "lenses", userId: "u1", opts: { workspaceId: WS } },
    ]);
    expect(h.focusReads).toBe(0);
  });

  it("falls back to the agent's declared focus workspace", async () => {
    h.focus = FOCUS;
    await run({}, "agent-1");
    expect(h.calls[0]!.opts).toEqual({ workspaceId: FOCUS });
  });

  it("passes NO workspace when nothing was declared — never a guess", async () => {
    await run({}, "agent-1");
    expect(h.calls[0]!.opts).toBeUndefined();
  });

  it("a human key (no agent identity) never reads a focus", async () => {
    await run({});
    expect(h.focusReads).toBe(0);
    expect(h.calls[0]!.opts).toBeUndefined();
  });
});
