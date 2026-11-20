/**
 * `synap_start_session` passes the service ONLY the space the caller pinned
 * (`confinedWorkspaceId`: its `workspaceId`, or the connector's
 * `?workspaceId=`, confined to a bound service key's space). The agent's
 * workspace focus is NOT folded in: it is the LAST rung of the space ladder
 * (`resolveSessionWorkspacePlacement`, W3 decision D1 a), below the
 * playbook's, the subject's, the parent's and the project's home space, and
 * the service reads it itself. Folded in here (plan A2-a, 2026-10-29) it was
 * passed as explicit and beat every fact.
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

const FOCUS = "33333333-3333-4333-8333-333333333333";
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

describe("synap_start_session — only a pinned space is explicit", () => {
  it("the agent's focus (the adapter's lens) is not passed as explicit", async () => {
    expect(
      await startedIn(
        ctx({}, { requestedWorkspaceId: FOCUS, lensWorkspaceId: FOCUS })
      )
    ).toBeUndefined();
  });

  it("the space the caller pinned is passed as explicit", async () => {
    expect(
      await startedIn(
        ctx(
          { workspaceId: NAMED },
          { confinedWorkspaceId: NAMED, lensWorkspaceId: NAMED }
        )
      )
    ).toBe(NAMED);
  });

  it("CONTROL — no lens and no arg: no workspace", async () => {
    expect(await startedIn(ctx({}))).toBeUndefined();
  });
});
