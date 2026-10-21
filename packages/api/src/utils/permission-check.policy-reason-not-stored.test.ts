/**
 * The governance POLICY's sentence is never stored as the proposer's reasoning.
 *
 * The defect: `createProposal({ reasoning: opts.reasoning ?? gov.reason })`
 * stored the engine's `PROPOSE_REASON` sentence ("An agent is creating a
 * workspace, cell, playbook or automation … no governance rule can widen it.")
 * as `data.reasoning` whenever the agent gave none, and the review page drew it
 * as the agent's own WHY. The fix stores only the caller's reasoning; the
 * sentence still answers the CALLER (`perm.reasoning`) and the engine's code is
 * stored as `governanceReason`.
 *
 * Seam: the row handed to `insertPendingProposal` — what the pod persists —
 * driven through the real `checkPermissionOrPropose`, with the engine and every
 * write seam mocked exactly as `permission-check.focus-session-criteria.test.ts`
 * does. The two fixtures rule out "never store reasoning" (the caller's own
 * reasoning must still land) and "store the sentence" (today's defect).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGov, mockVerifyPermission, mockInsertPendingProposal, mockValues } =
  vi.hoisted(() => ({
    mockGov: vi.fn(),
    mockVerifyPermission: vi.fn(),
    mockInsertPendingProposal: vi.fn(),
    mockValues: vi.fn(),
  }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  mockValues.mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: "receipt-1" }]),
  });
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "proposal-1" },
    deduped: false,
  });
  const select = () => {
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn(() => b),
      orderBy: vi.fn(() => b),
      leftJoin: vi.fn(() => b),
      limit: vi.fn().mockResolvedValue([]),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    };
    return b;
  };
  return {
    ...actual,
    db: {
      insert: vi.fn(() => ({ values: mockValues })),
      select,
      transaction: async (cb: (tx: unknown) => unknown) =>
        cb({ insert: vi.fn(() => ({ values: mockValues })) }),
      query: {
        focusSessions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: mockInsertPendingProposal,
    resolveAgentProposalSessionOnce: vi.fn().mockResolvedValue(null),
    resolveOrCreateAgentProposalSession: vi.fn().mockResolvedValue(null),
    deriveAgentProposalSessionGoal: vi.fn(() => "goal"),
    deriveProposalProjectId: vi.fn(async () => null),
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
    verifyPermission: mockVerifyPermission,
  };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: mockGov,
  resolveGovernanceRule: vi.fn().mockResolvedValue(null),
}));

vi.mock("@synap/jobs", () => ({
  broadcastNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { fromProposal: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: vi.fn(),
}));
vi.mock("../lib/event-helpers.js", () => ({
  logEvent: vi.fn().mockResolvedValue("event-1"),
}));

import { checkPermissionOrPropose } from "./permission-check.js";

const POLICY =
  "An agent wants to create or switch on a workspace, cell, playbook or automation, which changes what your pod does, so you approve it, and no rule can skip that.";

const agentWrite = (reasoning?: string) => ({
  userId: "user-abc",
  agentUserId: "agent-7",
  workspaceId: "ws-123",
  subjectType: "playbook" as const,
  action: "create" as const,
  source: "intelligence" as const,
  data: { name: "Evaluate an integration candidate" },
  ...(reasoning ? { reasoning } : {}),
});

/** The row `createProposal` handed the ONE pending-proposal insert. */
const storedRow = () =>
  mockInsertPendingProposal.mock.calls.at(-1)?.[0] as
    | { data: { reasoning?: string }; governanceReason?: string | null }
    | undefined;

describe("the policy sentence is not the proposer's reasoning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "receipt-1" }]),
    });
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "proposal-1" },
      deduped: false,
    });
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockGov.mockResolvedValue({
      decision: "propose",
      reason: POLICY,
      reasonCode: "AGENT_STRUCTURE_WRITE",
    });
  });

  it("no reasoning given ⇒ the stored row does not carry the policy sentence", async () => {
    const perm = await checkPermissionOrPropose(agentWrite());
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
    expect(storedRow()!.data.reasoning).not.toBe(POLICY);
    // The WHY-a-person code is still stored, under its own column.
    expect(storedRow()!.governanceReason).toBe("AGENT_STRUCTURE_WRITE");
    // The caller is still told why it was proposed.
    expect(perm).toMatchObject({ granted: false, reasoning: POLICY });
  });

  it("the proposer's own reasoning is stored as the reasoning", async () => {
    await checkPermissionOrPropose(
      agentWrite("Standardise how we score tools")
    );
    expect(storedRow()!.data.reasoning).toBe("Standardise how we score tools");
  });
});
