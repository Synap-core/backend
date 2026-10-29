/**
 * `synap_start_session` starts in the workspace the adapter resolved for the
 * call (`lensWorkspaceId`: `?workspaceId=`, or the agent's workspace focus,
 * access-checked), unless the caller named one. It used to pass the raw
 * `args.workspaceId` only, so a start ignored the focus the agent's own
 * captures were placed by (plan A2-a, 2026-10-29).
 *
 * No database: the service is mocked at its module seam, which is where this
 * door's job ends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../../../services/focus-sessions/create-session.js", () => ({
  createFocusSession: h.create,
}));

import { sessionHandlers } from "./session.js";
import type { McpToolContext } from "./shared.js";

const LENS = "33333333-3333-4333-8333-333333333333";
const NAMED = "44444444-4444-4444-8444-444444444444";

function ctx(
  args: Record<string, unknown>,
  over: Partial<McpToolContext> = {}
): McpToolContext {
  return {
    toolName: "synap_start_session",
    args: { goal: "Ship the filing fix", templateId: null, ...args },
    userId: "11111111-1111-4111-8111-111111111111",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "22222222-2222-4222-8222-222222222222",
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
    ...over,
  };
}

const startedIn = async (c: McpToolContext) => {
  await sessionHandlers.synap_start_session!(c);
  expect(h.create).toHaveBeenCalledTimes(1);
  return (h.create.mock.calls[0][0] as { workspaceId?: string }).workspaceId;
};

beforeEach(() => {
  h.create.mockReset();
  h.create.mockResolvedValue({
    status: "created",
    session: { id: "s-1", title: null, metadata: {} },
  });
});

describe("synap_start_session — the workspace lens", () => {
  it("starts in the lens workspace when the caller names none", async () => {
    expect(await startedIn(ctx({}, { lensWorkspaceId: LENS }))).toBe(LENS);
  });

  it("an explicit workspaceId still wins over the lens", async () => {
    expect(
      await startedIn(ctx({ workspaceId: NAMED }, { lensWorkspaceId: LENS }))
    ).toBe(NAMED);
  });

  it("CONTROL — no lens and no arg: no workspace", async () => {
    expect(await startedIn(ctx({}))).toBeUndefined();
  });
});
