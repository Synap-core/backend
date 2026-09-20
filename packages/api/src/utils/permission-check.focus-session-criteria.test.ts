/**
 * CRITERIA are PROPOSED by the agent and VALIDATED by the person.
 *
 * The defect this pins: `focus_session.update` sits in `DEFAULT_AUTO_APPROVE`
 * (rung 8) with a rationale about ORCHESTRATION — open a session, advance its
 * stage, update progress. `criteria` rode that whitelist, so an agent wrote both
 * the standard its work is graded against AND the grade. The whole
 * propose → revise → approve path already existed (`focus_session/update`
 * applies `data.criteria` on approval, proven on PGlite in
 * `routers/proposals/executors/__tests__/focus-session-playbook-instantiate.pglite.test.ts`,
 * "approved criteria change on focus_session/update") — it simply never fired.
 *
 * WHAT IS ASSERTED, and why it discriminates. The fix is one predicate feeding
 * `forcePropose` (rung 2.1, a floor ABOVE rung 8), so the observable seam is the
 * `forcePropose` the gate hands `resolveAgentGovernanceDecision` — the SAME
 * engine call the real ladder makes. Four candidate rules are ruled out, one per
 * fixture:
 *
 *   - "no predicate" (today)                 → ruled out by the criteria fixture;
 *   - "every focus_session.update proposes"  → ruled out by the progress/stage
 *     fixture, which must stay `false` (an agent advancing a session must not
 *     start filing proposals for a progress tick);
 *   - "any action carrying criteria"         → ruled out by the `create` fixture:
 *     a PLAN carries criteria on `create_session` and is approved as ONE
 *     proposal, so gating it again would double-gate an already-validated list;
 *   - "any caller carrying criteria"         → ruled out by the human fixture:
 *     the person writing their own criteria is not a proposal to themselves.
 *
 * DB-free: the engine and every write seam are mocked, exactly as
 * `permission-check.dry-run.test.ts` does (partial `importOriginal` mocks — see
 * `src/__tripwires__/database-mock-total-ratchet.test.ts`).
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

const SESSION = "00000000-0000-4000-8000-0000000000aa";
const CRITERION = {
  key: "report",
  statement: "A pricing report exists",
  check: { kind: "human" },
};

/** The gate call `updateFocusSession` makes: AI source, `data` per patched field. */
const aiUpdate = (data: Record<string, unknown>) => ({
  userId: "user-abc",
  agentUserId: "agent-7",
  workspaceId: "ws-123",
  subjectType: "focus_session" as const,
  action: "update" as const,
  source: "intelligence" as const,
  data: { id: SESSION, goal: "Ship pricing", ...data },
});

/** The `forcePropose` the gate handed the ONE governance engine. */
const forceProposeArg = () =>
  (mockGov.mock.calls.at(-1)?.[0] as { forcePropose?: boolean } | undefined)
    ?.forcePropose;

describe("an AI update that writes CRITERIA is floored to a proposal", () => {
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
    // The engine's OWN answer for this door today: rung 8 auto-approve. Every
    // fixture below therefore measures the FLOOR the gate applies above it, not
    // a mocked verdict — had the fixture mocked `propose`, it would pass with
    // or without the fix.
    mockGov.mockImplementation(
      async (input: { forcePropose?: boolean; reason?: string }) =>
        input.forcePropose
          ? { decision: "propose", reason: "scope/identity change" }
          : { decision: "execute", explicitAutoApproveFor: ["*"] }
    );
  });

  it("criteria → the engine is asked to force a proposal, and one is filed", async () => {
    const perm = await checkPermissionOrPropose(
      aiUpdate({ criteria: [CRITERION] })
    );
    expect(forceProposeArg()).toBe(true);
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
    expect(perm).toMatchObject({ granted: false, proposalId: "proposal-1" });
  });

  it("CLEARING the criteria is a contract change too, not an exemption", async () => {
    await checkPermissionOrPropose(aiUpdate({ criteria: [] }));
    expect(forceProposeArg()).toBe(true);
  });

  it("progress / stage / outputs keep auto-approving exactly as before", async () => {
    const perm = await checkPermissionOrPropose(
      aiUpdate({
        progress: 60,
        currentStage: "fix",
        expectedOutputs: [{ kind: "document", label: "Brief" }],
      })
    );
    expect(forceProposeArg()).toBe(false);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
    expect(perm).toMatchObject({ granted: true });
  });

  it("a PLAN's create_session carrying criteria is NOT double-gated", async () => {
    // A plan is approved as ONE proposal, so its criteria are already validated
    // by that approval; the plan door then calls `createFocusSession` directly.
    // Only `action: "update"` is floored.
    await checkPermissionOrPropose({
      ...aiUpdate({ criteria: [CRITERION] }),
      action: "create" as const,
    });
    expect(forceProposeArg()).toBe(false);
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("a HUMAN writing their own criteria stays immediate — no proposal to themselves", async () => {
    const perm = await checkPermissionOrPropose({
      ...aiUpdate({ criteria: [CRITERION] }),
      agentUserId: undefined,
      source: "user" as const,
    });
    expect(perm).toMatchObject({ granted: true });
    // The agent ladder is never consulted for a plain human write, so there is
    // no `forcePropose` to measure — the absence IS the assertion.
    expect(mockGov).not.toHaveBeenCalled();
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });
});
