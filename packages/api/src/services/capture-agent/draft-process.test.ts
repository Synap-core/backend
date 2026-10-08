/**
 * The "Draft a template" confirm goes through the ONE capture-graph door with
 * a single `create_playbook` op and NO entities — never a direct playbook
 * insert, never a second governance path — and it is IDEMPOTENT per
 * (workspace, kind): an open draft is returned, and a re-file carries a stable
 * idempotency key so the door returns the pending proposal instead of a second.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  submit: vi.fn(),
  openDraft: null as null | { id: string; name: string },
}));
vi.mock("./submit-capture-graph.js", () => ({ submitCaptureGraph: h.submit }));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const q = {
    from: () => q,
    where: () => q,
    orderBy: () => q,
    limit: async () => (h.openDraft ? [h.openDraft] : []),
  };
  return { ...actual, db: { select: () => q } };
});

import {
  draftProcessForKind,
  draftProcessIdempotencyKey,
} from "./draft-process.js";

const INPUT = {
  userId: "u1",
  agentUserId: "agent-1",
  workspaceId: "ws-1",
  profileSlug: "track",
  statusProperty: "track-status",
};

beforeEach(() => {
  h.submit.mockReset();
  h.openDraft = null;
});

describe("draftProcessForKind", () => {
  it("files one governed create_playbook op (draft) for the kind, under a stable key", async () => {
    h.submit.mockResolvedValue({ applied: false, proposalId: "p1" });
    await draftProcessForKind(INPUT);
    expect(h.submit).toHaveBeenCalledTimes(1);
    const arg = h.submit.mock.calls[0]![0];
    expect(arg).toMatchObject({
      userId: "u1",
      agentUserId: "agent-1",
      workspaceId: "ws-1",
      entities: [],
      rawSource: { idempotencyKey: "draft-process:ws-1:track" },
      summary: "Draft a template for tracks",
    });
    expect(arg.plan.playbooks).toEqual([
      expect.objectContaining({
        name: "Track template",
        status: "draft",
        subjectProfile: {
          profileSlug: "track",
          statusProperty: "track-status",
        },
      }),
    ]);
  });

  it("a repeat confirm with an OPEN draft returns it and files nothing", async () => {
    h.openDraft = { id: "pb-draft", name: "Track template" };
    const res = await draftProcessForKind(INPUT);
    expect(h.submit).not.toHaveBeenCalled();
    expect(res).toMatchObject({ applied: true, deduped: true });
    expect(res.plan?.steps).toEqual([
      expect.objectContaining({
        kind: "playbook",
        state: "applied",
        id: "pb-draft",
      }),
    ]);
  });

  it("the key does not depend on the lifecycle hint; a different name is a different draft", () => {
    expect(
      draftProcessIdempotencyKey({ workspaceId: "w", profileSlug: "post" })
    ).toBe("draft-process:w:post");
    expect(
      draftProcessIdempotencyKey({
        workspaceId: "w",
        profileSlug: "post",
        name: "Mine",
      })
    ).toBe("draft-process:w:post:Mine");
  });
});
