/**
 * The pod's DEFAULT sentences are never stored as the proposer's reasoning.
 *
 * Wave 1 stopped storing the governance policy sentence. Two more defaults were
 * still written into `data.reasoning` whenever the caller gave none, and drawn
 * on the review page as the proposer's own WHY:
 *   - the RBAC role-exceed line ("delete entity exceeds your workspace role
 *     (editor) — proposed for a reviewer's approval"), agent and person forms;
 *   - the gate's placeholder ("create playbook requires your approval").
 * The fix stores only the caller's words; the sentence still answers the
 * CALLER (`perm.reasoning`) and the notification.
 *
 * Seam: the row handed to `insertPendingProposal`, driven through the real
 * `checkPermissionOrPropose` — the mocks are the wave-1 file's
 * (`permission-check.policy-reason-not-stored.test.ts`), with the `select`
 * rows made settable so the RBAC branches can be reached.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGov,
  mockVerifyPermission,
  mockInsertPendingProposal,
  mockValues,
  selectRows,
} = vi.hoisted(() => ({
  mockGov: vi.fn(),
  mockVerifyPermission: vi.fn(),
  mockInsertPendingProposal: vi.fn(),
  mockValues: vi.fn(),
  // What every `select(...).limit()` resolves to — the RBAC branches read the
  // actor's userType, the workspace settings and the reviewer rows through it.
  selectRows: { current: [] as unknown[] },
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
      limit: vi.fn(async () => selectRows.current),
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

const storedRow = () =>
  mockInsertPendingProposal.mock.calls.at(-1)?.[0] as
    | { data: { reasoning?: string } }
    | undefined;

const write = (over: Record<string, unknown>) => ({
  userId: "user-abc",
  workspaceId: "ws-123",
  subjectType: "entity" as const,
  action: "delete" as const,
  source: "intelligence" as const,
  data: { id: "11111111-1111-4111-8111-111111111111" },
  ...over,
});

describe("system-written reasoning is not stored as the proposer's", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "receipt-1" }]),
    });
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "proposal-1" },
      deduped: false,
    });
    mockGov.mockResolvedValue({ decision: "propose", reason: undefined });
  });

  describe("RBAC role-exceed", () => {
    beforeEach(() => {
      mockVerifyPermission.mockResolvedValue({
        allowed: false,
        reason: "Insufficient permissions",
        role: "editor",
      });
      // An agent actor row; a workspace with default settings; another member
      // who can review.
      selectRows.current = [
        { userType: "agent", settings: {}, userId: "owner-1" },
      ];
    });

    it("agent, no reasoning ⇒ the row stores none; the caller hears the role line", async () => {
      const perm = await checkPermissionOrPropose(
        write({ agentUserId: "agent-7" })
      );
      expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
      expect(storedRow()!.data.reasoning).toBeUndefined();
      expect(perm).toMatchObject({
        granted: false,
        reasoning:
          "delete entity exceeds the agent's workspace role (editor) — proposed for your approval",
      });
    });

    it("person, no reasoning ⇒ the row stores none; the caller hears the role line", async () => {
      const perm = await checkPermissionOrPropose(write({}));
      expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
      expect(storedRow()!.data.reasoning).toBeUndefined();
      expect(perm).toMatchObject({
        granted: false,
        reasoning:
          "delete entity exceeds your workspace role (editor) — proposed for a reviewer's approval",
      });
    });

    it("the proposer's own reasoning is still stored", async () => {
      await checkPermissionOrPropose(
        write({ agentUserId: "agent-7", reasoning: "Duplicate of Acme" })
      );
      expect(storedRow()!.data.reasoning).toBe("Duplicate of Acme");
    });
  });

  it("no reasoning on a plain propose ⇒ no placeholder stored", async () => {
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    selectRows.current = [];
    const perm = await checkPermissionOrPropose(
      write({
        agentUserId: "agent-7",
        subjectType: "playbook",
        action: "create",
        data: { name: "Evaluate an integration candidate" },
      })
    );
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
    expect(storedRow()!.data.reasoning).toBeUndefined();
    expect(perm).toMatchObject({
      reasoning: "create playbook requires your approval",
    });
  });
});
