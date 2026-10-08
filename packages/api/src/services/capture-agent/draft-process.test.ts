/**
 * The "Draft a process for this" confirm goes through the ONE capture-graph
 * door with a single `create_playbook` op and NO entities — never a direct
 * playbook insert, never a second governance path.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("./submit-capture-graph.js", () => ({ submitCaptureGraph: h.submit }));

import { draftProcessForKind } from "./draft-process.js";

describe("draftProcessForKind", () => {
  it("files one governed create_playbook op (draft) for the kind", async () => {
    h.submit.mockResolvedValue({ applied: false, proposalId: "p1" });
    await draftProcessForKind({
      userId: "u1",
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      profileSlug: "track",
      statusProperty: "track-status",
    });
    expect(h.submit).toHaveBeenCalledTimes(1);
    const arg = h.submit.mock.calls[0]![0];
    expect(arg).toMatchObject({
      userId: "u1",
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      entities: [],
    });
    expect(arg.plan.playbooks).toEqual([
      expect.objectContaining({
        status: "draft",
        subjectProfile: {
          profileSlug: "track",
          statusProperty: "track-status",
        },
      }),
    ]);
  });
});
