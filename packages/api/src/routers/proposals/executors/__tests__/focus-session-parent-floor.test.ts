/**
 * APPROVING a `focus_session/create` floors its PARENT edge on the proposal's
 * SUBJECT, never on the approver (E1 open issue, closed here).
 *
 * The parent id in `data` was authored by the proposer. Flooring the
 * `spawned_from` producer on the APPROVING user meant an admin approving a
 * teammate's proposal could link the new session under the ADMIN's own
 * session — the same cross-owner shape the blocker half already refused
 * (`applyApprovedBlockedBy`). Harness mirrors `focus-session-expected-outputs`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  spawnCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const session = {
    id: "11111111-2222-4333-8444-555555555555",
    workspaceId: "ws-1",
    channelId: "channel-1",
    status: "active",
    goal: "child",
    progress: 0,
  };
  return {
    ...actual,
    recordSessionSpawn: async (input: Record<string, unknown>) => {
      h.spawnCalls.push(input);
      return { linked: true, suspendedIntentRecorded: false };
    },
    db: {
      select: () => {
        const b: Record<string, unknown> = {
          from: () => b,
          where: async () => [{ status: "pending" }],
        };
        return b;
      },
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [session] }),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    },
  };
});

vi.mock("../../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => {},
}));

import { proposalExecRegistry } from "../../execution-registry.js";
import type { ProposalExecutorArgs } from "../../execution-registry.js";
import { registerFocusSessionExecutors } from "../focus-session.js";

const PARENT = "99999999-2222-4333-8444-555555555555";

function args(subjectUserId: string | null): ProposalExecutorArgs {
  return {
    proposal: {
      id: "p-1",
      targetType: "focus_session",
      targetId: "11111111-2222-4333-8444-555555555555",
      proposalType: "create",
      workspaceId: "ws-1",
      sessionId: null,
      projectId: null,
      agentUserId: "agent-1",
      subjectUserId,
      sourceMessageId: null,
      data: { data: { goal: "child", parentSessionId: PARENT } },
    },
    payload: null,
    // The APPROVER — an admin, not the principal the proposal was filed for.
    userId: "admin-approver",
    input: { proposalId: "p-1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {
      db: null,
      emitProposalReviewed: () => {},
      reportProposalOutcome: () => {},
      stampProjectMembership: async () => {},
      resolveMessagingAccountForPlatform: async () => null,
    } as unknown as ProposalExecutorArgs["deps"],
  } as unknown as ProposalExecutorArgs;
}

describe("focus_session/create approval — parent edge floor", () => {
  beforeEach(() => {
    h.spawnCalls.length = 0;
    registerFocusSessionExecutors();
  });

  it("floors the spawned_from producer on the proposal SUBJECT, not the approver", async () => {
    const executor = proposalExecRegistry.resolveExact("focus_session/create");
    expect(
      executor,
      "focus_session/create executor not registered"
    ).toBeDefined();
    await executor!.execute(args("owner-of-the-proposal"));
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]).toEqual(
      expect.objectContaining({
        parentSessionId: PARENT,
        userId: "owner-of-the-proposal",
      })
    );
  });

  it("refuses the edge (reported, not written) when the proposal records no subject", async () => {
    const executor = proposalExecRegistry.resolveExact("focus_session/create");
    const result = (await executor!.execute(args(null))) as {
      refusals?: string[];
    };
    expect(h.spawnCalls).toHaveLength(0);
    expect(result.refusals?.join(" ")).toMatch(/records no owner/);
  });
});
