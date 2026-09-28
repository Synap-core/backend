/**
 * `workspaces.updateBrief` reaches the ONE brief door with the caller's
 * identity and the patch VALUE, through the real router (`workspacesRouter`
 * createCaller, real middleware, real zod input). Only the door is spied —
 * its governance is tested in services/space-brief-door.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ door: vi.fn() }));

vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../services/space-brief-door.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/space-brief-door.js")
  >()),
  updateSpaceBriefGoverned: h.door,
}));

import { workspacesRouter } from "../workspaces.js";

const WS = "f001a1a7-56d1-4734-8b9a-cbbe9c28bb01";
const caller = (ctx: Record<string, unknown>) =>
  workspacesRouter.createCaller({ authenticated: true, ...ctx } as never);

describe("workspaces.updateBrief", () => {
  beforeEach(() => {
    h.door.mockReset().mockResolvedValue({
      status: "proposed",
      proposalId: "p-1",
      changes: [{ field: "framing", after: "The strategist." }],
    });
  });

  it("a user write hands the door the user, the space and the patch value", async () => {
    const out = await caller({ userId: "u1" }).updateBrief({
      workspaceId: WS,
      patch: { framing: "The strategist.", goal: null },
      reasoning: "clearer persona",
    });
    expect(h.door).toHaveBeenCalledWith({
      userId: "u1",
      agentUserId: null,
      workspaceId: WS,
      patch: { framing: "The strategist.", goal: null },
      reasoning: "clearer persona",
    });
    // The door's governed result is returned as-is (here: proposed).
    expect(out).toEqual({
      status: "proposed",
      proposalId: "p-1",
      changes: [{ field: "framing", after: "The strategist." }],
    });
  });

  it("an agent caller is forwarded as the agent, so the door proposes", async () => {
    await caller({ userId: "u1", agentUserId: "agent-9" }).updateBrief({
      workspaceId: WS,
      patch: { purpose: "Brand source of truth." },
    });
    expect(h.door.mock.calls[0]![0]).toMatchObject({
      userId: "u1",
      agentUserId: "agent-9",
    });
  });

  it("refuses a key that is not a patchable brief field, before the door", async () => {
    await expect(
      caller({ userId: "u1" }).updateBrief({
        workspaceId: WS,
        patch: { rules: [{ key: "x" }] } as never,
      })
    ).rejects.toThrow();
    expect(h.door).not.toHaveBeenCalled();
  });
});
