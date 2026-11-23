/**
 * `synap_start_session` hands `blockedByEntityIds` / `blockedByTrackIds` (a
 * decision or a goal the new session waits on) to the service, and refuses a
 * malformed list in words before anything is created. The edges themselves
 * are written and reported by the service (`create-session-cross-blockers`
 * pglite test); this pins the door's plumbing, at the service's module seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("../../../services/focus-sessions/create-session.js", () => ({
  createFocusSession: h.create,
}));

import { sessionHandlers } from "./session.js";
import type { McpToolContext } from "./shared.js";

const DECISION = "33333333-3333-4333-8333-333333333333";
const GOAL = "44444444-4444-4444-8444-444444444444";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_start_session",
    args: { goal: "Sign the term sheet", templateId: null, ...args },
    userId: "11111111-1111-4111-8111-111111111111",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: "22222222-2222-4222-8222-222222222222",
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  };
}

const textOf = (r: { content: unknown }) =>
  JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  h.create.mockReset();
  h.create.mockResolvedValue({
    status: "created",
    session: { id: "s-1", title: null, metadata: {} },
  });
});

describe("synap_start_session — born waiting on a decision or a goal", () => {
  it("passes both lists to the service", async () => {
    await sessionHandlers.synap_start_session!(
      ctx({ blockedByEntityIds: [DECISION], blockedByTrackIds: [GOAL] })
    );
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0]).toMatchObject({
      blockedByEntityIds: [DECISION],
      blockedByTrackIds: [GOAL],
    });
  });

  it("CONTROL: no list, empty lists", async () => {
    await sessionHandlers.synap_start_session!(ctx({}));
    expect(h.create.mock.calls[0][0]).toMatchObject({
      blockedByEntityIds: [],
      blockedByTrackIds: [],
    });
  });

  it("refuses a malformed list in words, and creates nothing", async () => {
    const out = textOf(
      await sessionHandlers.synap_start_session!(
        ctx({ blockedByEntityIds: ["not-a-uuid"] })
      )
    );
    expect(out.error).toMatch(/blockedByEntityIds must be an array/);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("a decision's ARM rides as `<id>:<option>` (P5); a goal list takes no arm", async () => {
    await sessionHandlers.synap_start_session!(
      ctx({ blockedByEntityIds: [`${DECISION}:raise`] })
    );
    expect(h.create.mock.calls[0][0]).toMatchObject({
      blockedByEntityIds: [`${DECISION}:raise`],
    });
    h.create.mockClear();
    const goal = textOf(
      await sessionHandlers.synap_start_session!(
        ctx({ blockedByTrackIds: [`${GOAL}:raise`] })
      )
    );
    expect(goal.error).toMatch(/blockedByTrackIds must be an array/);
    const empty = textOf(
      await sessionHandlers.synap_start_session!(
        ctx({ blockedByEntityIds: [`${DECISION}:`] })
      )
    );
    expect(empty.error).toMatch(/blockedByEntityIds must be an array/);
    expect(h.create).not.toHaveBeenCalled();
  });
});
