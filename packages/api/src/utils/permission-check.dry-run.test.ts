import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * DECISION-ONLY (dry-run) mode — `previewPermissionDecision`.
 *
 * It must resolve the SAME verdict as `checkPermissionOrPropose` through the
 * SAME rungs (same `resolveAgentGovernanceDecision` engine, same RBAC) while
 * performing ZERO side effects. Every side effect the propose/execute paths own
 * is asserted absent here:
 *
 *   - the PENDING proposal row (`insertPendingProposal`)
 *   - the AUTO_APPROVED receipt row (`db.insert`)
 *   - the `.requested` event append (inside the proposal transaction)
 *   - the notification fan-out (broadcast / side-effects / NotificationService)
 *   - the `workspace.join` proposal (event-backed proposal door)
 *   - the daily agent-proposal cap (neither read nor consumed)
 *
 * The commit-mode counterpart is asserted alongside each case, so a rung that
 * silently changes behaviour under dry-run fails here.
 *
 * DB-free — every I/O module is mocked.
 */

const {
  mockDbInsert,
  mockDbSelect,
  mockDbTransaction,
  mockValues,
  mockReturning,
  mockInsertPendingProposal,
  mockGov,
  mockVerifyPermission,
  mockBroadcast,
  mockEmitSideEffects,
  mockNotifyFromProposal,
  mockCreateEventBackedProposal,
} = vi.hoisted(() => ({
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
  mockDbTransaction: vi.fn(),
  mockValues: vi.fn(),
  mockReturning: vi.fn(),
  mockInsertPendingProposal: vi.fn(),
  mockGov: vi.fn(),
  mockVerifyPermission: vi.fn(),
  mockBroadcast: vi.fn().mockResolvedValue(undefined),
  mockEmitSideEffects: vi.fn(),
  mockNotifyFromProposal: vi.fn().mockResolvedValue(undefined),
  mockCreateEventBackedProposal: vi.fn(),
}));

vi.mock("@synap/database", async () => {
  mockReturning.mockResolvedValue([{ id: "receipt-1" }]);
  mockValues.mockReturnValue({ returning: mockReturning });
  mockDbInsert.mockImplementation(() => ({ values: mockValues }));
  mockDbSelect.mockImplementation(() => {
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn(() => b),
      orderBy: vi.fn(() => b),
      limit: vi.fn().mockResolvedValue([]),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    };
    return b;
  });
  mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ insert: mockDbInsert })
  );
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "proposal-1" },
    deduped: false,
  });
  return {
    db: {
      insert: mockDbInsert,
      select: mockDbSelect,
      transaction: mockDbTransaction,
      query: {
        focusSessions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: mockInsertPendingProposal,
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
    proposals: {},
    entities: {},
    eq: vi.fn((a: unknown, b: unknown) => ({ field: a, value: b })),
    and: vi.fn((...conds: unknown[]) => ({ and: conds })),
    or: vi.fn((...conds: unknown[]) => ({ or: conds })),
    isNull: vi.fn((a: unknown) => ({ isNull: a })),
    gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
    gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
    desc: vi.fn((a: unknown) => ({ desc: a })),
    drizzleSql: vi.fn(() => ({})),
    verifyPermission: mockVerifyPermission,
    ProfileResolutionService: class {
      resolveProfile = vi.fn().mockResolvedValue({ id: "p-1", slug: "task" });
    },
  };
});

vi.mock("@synap/database/agent-governance", () => ({
  resolveAgentGovernanceDecision: mockGov,
  resolveGovernanceRule: vi.fn().mockResolvedValue(null),
}));

vi.mock("@synap/jobs", () => ({ broadcastNotification: mockBroadcast }));
vi.mock("@synap/events", () => ({ emitSideEffects: mockEmitSideEffects }));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { fromProposal: mockNotifyFromProposal },
}));
vi.mock("../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: vi.fn(),
}));
vi.mock("./event-backed-proposal.js", () => ({
  createEventBackedProposal: mockCreateEventBackedProposal,
}));
vi.mock("../lib/event-helpers.js", () => ({
  logEvent: vi.fn().mockResolvedValue("event-1"),
}));

import {
  checkPermissionOrPropose as checkPermissionOrProposeStrict,
  previewPermissionDecision as previewPermissionDecisionStrict,
} from "./permission-check.js";
import type { PermissionCheckOpts } from "./permission-check.js";

/**
 * OFF-VOCABULARY TEST DOOR.
 *
 * `PermissionCheckOpts` now pins the `(subjectType, action)` PAIR to
 * `GATE_WRITE_DOORS` in `@synap/governance-policy`, so a real call site cannot
 * invent a door. These tests deliberately probe the ladder with pairs that are
 * NOT production doors (`filesystem/write`, `document/update`, ...) to prove the
 * generic behaviour, so they widen the door back to plain strings here.
 *
 * This shim is CONFINED to test files on purpose: production narrowing is
 * unaffected, and the tripwire's LEFT side stays the real vocabulary. Do NOT
 * copy it into src.
 */
type OffVocabularyOpts = Omit<PermissionCheckOpts, "subjectType" | "action"> & {
  subjectType: string;
  action: string;
};

const checkPermissionOrPropose = (opts: OffVocabularyOpts) =>
  checkPermissionOrProposeStrict(opts as unknown as PermissionCheckOpts);
const previewPermissionDecision = (opts: OffVocabularyOpts) =>
  previewPermissionDecisionStrict(opts as unknown as PermissionCheckOpts);

const OPTS = {
  userId: "user-abc",
  agentUserId: "agent-7",
  workspaceId: "ws-123",
  subjectType: "entity",
  action: "create",
  source: "ai" as const,
  data: { id: "ent-xyz", title: "My Entity" },
};

/** Every write/notify seam the propose + execute paths can touch. */
function expectNoSideEffects() {
  expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  expect(mockDbInsert).not.toHaveBeenCalled();
  expect(mockDbTransaction).not.toHaveBeenCalled();
  expect(mockCreateEventBackedProposal).not.toHaveBeenCalled();
  expect(mockBroadcast).not.toHaveBeenCalled();
  expect(mockEmitSideEffects).not.toHaveBeenCalled();
  expect(mockNotifyFromProposal).not.toHaveBeenCalled();
}

describe("previewPermissionDecision — decision-only governance door", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([{ id: "receipt-1" }]);
    mockValues.mockReturnValue({ returning: mockReturning });
    mockDbInsert.mockImplementation(() => ({ values: mockValues }));
    mockDbTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ insert: mockDbInsert })
    );
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "proposal-1" },
      deduped: false,
    });
    mockVerifyPermission.mockResolvedValue({ allowed: true });
  });

  it("reports EXECUTE without writing the auto-approve receipt", async () => {
    mockGov.mockResolvedValue({
      decision: "execute",
      explicitAutoApproveFor: ["entity.create"],
    });

    await expect(previewPermissionDecision(OPTS)).resolves.toEqual({
      decision: "execute",
    });
    expectNoSideEffects();

    // Same rungs, commit mode → the receipt DOES land.
    await checkPermissionOrPropose(OPTS);
    expect(mockDbInsert).toHaveBeenCalledTimes(1);
  });

  it("reports PROPOSE without inserting a proposal row or notifying", async () => {
    mockGov.mockResolvedValue({ decision: "propose", reason: "needs review" });

    await expect(previewPermissionDecision(OPTS)).resolves.toEqual({
      decision: "propose",
    });
    expectNoSideEffects();

    // Same rungs, commit mode → the pending proposal DOES land.
    const perm = await checkPermissionOrPropose(OPTS);
    expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
    expect(perm).toMatchObject({ granted: false, proposalId: "proposal-1" });
  });

  it("reports DENY with the same reason the real gate denies with (governance verdict)", async () => {
    mockGov.mockResolvedValue({
      decision: "deny",
      reason: "blocked by policy",
    });

    await expect(previewPermissionDecision(OPTS)).resolves.toEqual({
      decision: "deny",
      reason: "blocked by policy",
    });
    expectNoSideEffects();

    await expect(checkPermissionOrPropose(OPTS)).resolves.toEqual({
      denied: true,
      reason: "blocked by policy",
    });
  });

  it("reports DENY with the same reason on an RBAC failure (non-agent caller)", async () => {
    mockVerifyPermission.mockResolvedValue({
      allowed: false,
      reason: "User is not a member of this workspace",
    });
    const humanOpts = { ...OPTS, agentUserId: undefined, source: "user" };

    await expect(previewPermissionDecision(humanOpts)).resolves.toEqual({
      decision: "deny",
      reason: "User is not a member of this workspace",
    });
    expectNoSideEffects();

    await expect(checkPermissionOrPropose(humanOpts)).resolves.toEqual({
      denied: true,
      reason: "User is not a member of this workspace",
    });
  });

  it("reports PROPOSE for an untrusted issuer without filing the proposal", async () => {
    mockGov.mockResolvedValue({
      decision: "execute",
      explicitAutoApproveFor: ["entity.create"],
    });
    const untrusted = {
      ...OPTS,
      issuer: { kind: "view" as const, trusted: false },
    };

    await expect(previewPermissionDecision(untrusted)).resolves.toEqual({
      decision: "propose",
    });
    expectNoSideEffects();
  });

  it("reports PROPOSE for an agent that is not a workspace member, without filing a join proposal", async () => {
    mockVerifyPermission.mockResolvedValue({
      allowed: false,
      reason: "User is not a member of this workspace",
    });
    // The agent-user confirmation read inside the join door returns an agent row.
    mockDbSelect.mockImplementation(() => {
      const b: Record<string, unknown> = {
        from: vi.fn(() => b),
        where: vi.fn(() => b),
        orderBy: vi.fn(() => b),
        limit: vi.fn().mockResolvedValue([{ userType: "agent", name: "Ada" }]),
      };
      return b;
    });

    await expect(previewPermissionDecision(OPTS)).resolves.toEqual({
      decision: "propose",
    });
    expectNoSideEffects();
  });

  it("grants (EXECUTE) a plain human write with no AI source, unchanged", async () => {
    const humanOpts = {
      ...OPTS,
      agentUserId: undefined,
      source: "user",
    };

    await expect(previewPermissionDecision(humanOpts)).resolves.toEqual({
      decision: "execute",
    });
    expectNoSideEffects();
    expect(mockGov).not.toHaveBeenCalled();
  });
});
