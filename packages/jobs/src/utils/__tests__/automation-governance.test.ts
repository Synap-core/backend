import { describe, it, expect, beforeEach, vi } from "vitest";

// Boundary mocks. checkAutomationWriteOrPropose is thin orchestration over
// RBAC (verifyPermission) + the agent policy decision (decideAgentPolicy) +
// the proposal insert. This test proves proposeAutomationWrite (private,
// reached only via the "propose" verdict branch) stamps `sessionId` onto the
// created proposal row when the caller passes one — the new provenance wiring
// added so every non-playbook automation run's proposals group under the
// run's focus session.
const {
  verifyPermissionMock,
  decideAgentPolicyMock,
  selectQueue,
  insertPendingProposalMock,
  broadcastMock,
  emitSideEffectsMock,
} = vi.hoisted(() => {
  // proposeAutomationWrite now delegates the row INSERT to the shared
  // insertPendingProposal (SSOT in @synap/database); assert on its call args.
  const insertPendingProposalMock = vi.fn(
    async (_input: Record<string, unknown>) => ({
      proposal: { id: "proposal-1" },
      deduped: false,
    })
  );
  return {
    verifyPermissionMock: vi.fn(async () => ({ allowed: true })),
    decideAgentPolicyMock: vi.fn(() => ({
      verdict: "propose" as const,
      reason: "default propose",
    })),
    // Queue of rows returned by successive db.select(...).from(...).where(...).limit(1)
    // calls — first the owning-user lookup, then the workspace lookup.
    selectQueue: { rows: [] as Array<Record<string, unknown>>[] },
    insertPendingProposalMock,
    broadcastMock: vi.fn(async () => undefined),
    emitSideEffectsMock: vi.fn(),
  };
});

vi.mock("@synap/database", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          // Chainable AND thenable: `.limit(1)` serves the owning-user /
          // workspace lookups; a bare `await ...where(...)` (no `.limit()`)
          // serves `resolveGovernanceRule`'s governance_rules query (rung
          // 2.8's I/O half) — both consume the SAME queue, in call order.
          const rows = selectQueue.rows.shift() ?? [];
          return {
            limit: vi.fn(async () => rows),
            then: (
              resolve: (v: unknown) => unknown,
              reject: (e: unknown) => unknown
            ) => Promise.resolve(rows).then(resolve, reject),
          };
        }),
      })),
    })),
  },
  eq: vi.fn(),
  users: { id: "users.id" },
  workspaces: { id: "workspaces.id" },
  verifyPermission: verifyPermissionMock,
  ProposalStatus: { PENDING: "pending" },
  insertPendingProposal: insertPendingProposalMock,
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: emitSideEffectsMock,
}));

vi.mock("../realtime-broadcast.js", () => ({
  broadcastNotification: broadcastMock,
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@synap/governance-policy", () => ({
  decideAgentPolicy: decideAgentPolicyMock,
  requiredPermissionFor: vi.fn(() => "write"),
  getWorkspaceGovernanceMode: vi.fn(() => "standard"),
}));

import { checkAutomationWriteOrPropose } from "../automation-governance.js";

beforeEach(() => {
  verifyPermissionMock.mockClear();
  verifyPermissionMock.mockResolvedValue({ allowed: true });
  decideAgentPolicyMock.mockClear();
  decideAgentPolicyMock.mockReturnValue({
    verdict: "propose",
    reason: "default propose",
  });
  insertPendingProposalMock.mockClear();
  insertPendingProposalMock.mockResolvedValue({
    proposal: { id: "proposal-1" },
    deduped: false,
  });
  broadcastMock.mockClear();
  emitSideEffectsMock.mockClear();
  // Owning-user lookup returns an agent user (so agent governance applies and
  // the propose branch is reachable), then the workspace lookup.
  selectQueue.rows = [
    [{ userType: "agent", agentMetadata: null }],
    [{ settings: {}, workspaceType: "workspace" }],
  ];
});

describe("checkAutomationWriteOrPropose → proposeAutomationWrite", () => {
  it("stamps sessionId onto the created proposal when the caller passes one", async () => {
    const result = await checkAutomationWriteOrPropose({
      ownerId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      data: { profileSlug: "note", title: "Test" },
      automationRunId: "run-1",
      correlationId: "root-run-1",
      sessionId: "session-1",
    });

    expect(result).toEqual({ proposed: true, proposalId: "proposal-1" });
    expect(insertPendingProposalMock).toHaveBeenCalledTimes(1);
    const inserted = insertPendingProposalMock.mock.calls[0][0];
    expect(inserted.sessionId).toBe("session-1");
  });

  it("stamps a null sessionId when the caller doesn't pass one", async () => {
    selectQueue.rows = [
      [{ userType: "agent", agentMetadata: null }],
      [{ settings: {}, workspaceType: "workspace" }],
    ];

    await checkAutomationWriteOrPropose({
      ownerId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      data: { profileSlug: "note", title: "Test" },
      automationRunId: "run-1",
      correlationId: "root-run-1",
    });

    const inserted = insertPendingProposalMock.mock.calls[0][0];
    expect(inserted.sessionId).toBeNull();
  });

  /**
   * ENVELOPE SHAPE. The approve executors (`api` — routers/proposals/
   * approve-executors.ts `entity/create`) read the write payload from
   * `proposal.data.data` — the REQUEST-SHAPED envelope the canonical chat door
   * (`checkPermissionOrPropose` → `createProposal`) stores. This door used to
   * persist the payload FLAT, so approving a proposal-gated automation
   * `entity.create` threw "Entity proposal is missing profileSlug" and the
   * proposal could never be applied.
   */
  it("persists the write payload in the REQUEST-SHAPED envelope the approve path reads", async () => {
    selectQueue.rows = [
      [{ userType: "agent", agentMetadata: null }],
      [{ settings: {}, workspaceType: "workspace" }],
    ];

    await checkAutomationWriteOrPropose({
      ownerId: "agent-1",
      workspaceId: "ws-1",
      subjectType: "entity",
      action: "create",
      data: {
        profileSlug: "note",
        title: "Test",
        properties: { url: "https://x" },
        content: "long body",
      },
      automationRunId: "run-1",
      correlationId: "root-run-1",
    });

    const inserted = insertPendingProposalMock.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    const inner = inserted.data.data as Record<string, unknown>;
    // The payload the approve executor reads.
    expect(inner).toEqual({
      profileSlug: "note",
      title: "Test",
      properties: { url: "https://x" },
      content: "long body",
    });
    // The request-shaped siblings.
    expect(inserted.data.targetType).toBe("entity");
    expect(inserted.data.changeType).toBe("create");
    expect(typeof inserted.data.targetId).toBe("string");
    // The automation-specific top-level keys are UNCHANGED (existing readers).
    expect(inserted.data.source).toBe("automation");
    expect(inserted.data.agentUserId).toBe("agent-1");
    expect(inserted.data.authorshipMode).toBe("autonomous");
    expect(inserted.data.automationRunId).toBe("run-1");
    expect(inserted.data.correlationId).toBe("root-run-1");
    // …and the payload keys no longer sit at the TOP level (the old flat shape).
    expect(inserted.data.profileSlug).toBeUndefined();
  });
});
