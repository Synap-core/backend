/**
 * `synap_start_session` is an agent's start, so it asks the service to require
 * a criterion (F11, `requireCriteria`), and a NO_CRITERIA refusal comes back
 * as `status: "refused"` with the service's sentence, not as a tool fault.
 *
 * No database: the service is mocked at its module seam, which is where this
 * door's job ends (the rule itself: `create-session.require-criteria.pglite`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../../../services/focus-sessions/create-session.js", () => ({
  createFocusSession: h.create,
}));

import { sessionHandlers } from "./session.js";
import type { McpToolContext } from "./shared.js";

function ctx(args: Record<string, unknown> = {}): McpToolContext {
  return {
    toolName: "synap_start_session",
    args: { goal: "Ship the filing fix", templateId: null, ...args },
    userId: "11111111-1111-4111-8111-111111111111",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "22222222-2222-4222-8222-222222222222",
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  };
}

beforeEach(() => {
  h.create.mockReset();
});

describe("synap_start_session — done is declared", () => {
  it("asks the service to require a criterion", async () => {
    h.create.mockResolvedValue({
      status: "created",
      session: { id: "s-1", title: null, metadata: {} },
    });
    await sessionHandlers.synap_start_session!(ctx());
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(
      (h.create.mock.calls[0][0] as { requireCriteria?: boolean })
        .requireCriteria
    ).toBe(true);
  });

  it("answers NO_CRITERIA as a refusal the agent can act on", async () => {
    h.create.mockRejectedValue(
      Object.assign(new Error("Not started: say what done means."), {
        code: "BAD_REQUEST",
        reasonCode: "NO_CRITERIA",
      })
    );
    const res = await sessionHandlers.synap_start_session!(ctx());
    const body = JSON.parse(
      (res.content as Array<{ text: string }>)[0]!.text
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "refused",
      reasonCode: "NO_CRITERIA",
      error: "Not started: say what done means.",
    });
  });
});
