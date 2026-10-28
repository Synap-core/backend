/**
 * An agent's newer version REPLACES its older pending one
 * (`insertPendingProposal`'s supersede), and the replaced row gets the rest of
 * a withdrawal: the live queue drops it and its staged source blob is
 * discarded — what the person's own withdraw door runs
 * (`proposals.withdraw`). Without it the row stayed on every open review
 * screen until a refetch, and its blob was orphaned for good.
 *
 * Seam: the REAL `checkPermissionOrPropose` → the pending insert (stubbed to
 * report one superseded version) → the post-commit settlement, asserted on
 * the two side-effect doors it must reach. Engine and write seams mocked as
 * in `permission-check.create-dedup-hash.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGov,
  mockVerifyPermission,
  mockInsertPendingProposal,
  mockValues,
  mockEmitReviewed,
  mockDiscardBlob,
} = vi.hoisted(() => ({
  mockGov: vi.fn(),
  mockVerifyPermission: vi.fn(),
  mockInsertPendingProposal: vi.fn(),
  mockValues: vi.fn(),
  mockEmitReviewed: vi.fn(),
  mockDiscardBlob: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const select = () => {
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn(() => b),
      orderBy: vi.fn(() => b),
      leftJoin: vi.fn(() => b),
      innerJoin: vi.fn(() => b),
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
        entities: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: mockInsertPendingProposal,
    resolveAgentProposalSessionOnce: vi.fn().mockResolvedValue(null),
    resolveOrCreateAgentProposalSession: vi.fn().mockResolvedValue(null),
    deriveAgentProposalSessionGoal: vi.fn(() => "goal"),
    deriveProposalProjectId: vi.fn(async () => null),
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
    verifyPermission: mockVerifyPermission,
    // The gate refuses an entity create whose kind does not resolve (4c).
    ProfileResolutionService: class {
      async resolveProfile(slug: string) {
        return { id: `profile-${slug}`, slug, profileKind: "kind" };
      }
      async getEffectiveLifecycle() {
        return null;
      }
    },
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

vi.mock("../routers/proposals/apply-approval.js", () => ({
  emitProposalReviewed: mockEmitReviewed,
}));
vi.mock("./store-entity-source-blob.js", () => ({
  discardProposalSourceBlob: mockDiscardBlob,
}));

import { checkPermissionOrPropose } from "./permission-check.js";

const STAGED = { sourceFile: { documentId: "doc-1", storageKey: "k/1" } };

describe("a superseded version gets the rest of its withdrawal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "receipt-1" }]),
    });
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "proposal-2" },
      deduped: false,
      superseded: [{ id: "proposal-1", workspaceId: "ws-123", data: STAGED }],
    });
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockGov.mockResolvedValue({
      decision: "propose",
      reason: "A person approves this.",
      reasonCode: "DEFAULT_PROPOSE",
    });
  });

  it("the replaced row leaves the live queue and its staged blob is discarded", async () => {
    const result = await checkPermissionOrPropose({
      userId: "user-abc",
      agentUserId: "agent-7",
      workspaceId: "ws-123",
      subjectType: "entity",
      action: "update",
      source: "intelligence",
      data: { id: "entity-1", title: "v2" },
    });
    expect(result).toMatchObject({ proposalId: "proposal-2" });
    expect(mockEmitReviewed).toHaveBeenCalledWith(
      "proposal-1",
      "ws-123",
      "withdrawn",
      "user-abc"
    );
    expect(mockDiscardBlob).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-abc", proposalData: STAGED })
    );
  });

  it("nothing replaced, nothing settled", async () => {
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "proposal-3" },
      deduped: false,
      superseded: [],
    });
    await checkPermissionOrPropose({
      userId: "user-abc",
      agentUserId: "agent-7",
      workspaceId: "ws-123",
      subjectType: "entity",
      action: "update",
      source: "intelligence",
      data: { id: "entity-1", title: "v3" },
    });
    expect(mockEmitReviewed).not.toHaveBeenCalled();
    expect(mockDiscardBlob).not.toHaveBeenCalled();
  });
});
