import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Text tiers (b) — the SEAM between the gate and the governance resolver: a
 * `document/update` hands the resolver the document it targets
 * (`subjectDocumentId` = the gate `data.id`), which is what lets the resolver
 * classify a human-owned entity's body onto the entity lane. Any other subject
 * hands it nothing. The resolver's own behaviour is covered in @synap/database
 * (`resolve-agent-governance-decision.body-lane.pglite.test.ts`); here only the
 * threading is asserted, through the side-effect-free preview door.
 *
 * Harness copied from `permission-check.dry-run.test.ts` (DB-free).
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

/**
 * PARTIAL mock (`importOriginal` + spread) — see
 * `src/__tripwires__/database-mock-total-ratchet.test.ts`. This was TOTAL and it
 * had already gone dark: `countPendingAgentProposals` started calling `ne(...)`
 * and the propose test failed with *No "ne" export is defined on the mock*.
 * That comment below about the provenance hoist is the SECOND time the same
 * thing happened to this file — it was patched by adding more names to the
 * hand-list, which fixes one instance and leaves the class. Spreading the real
 * module retires it: a name this file never fakes now resolves to the real one.
 */
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
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
    ...actual,
    db: {
      insert: mockDbInsert,
      select: mockDbSelect,
      transaction: mockDbTransaction,
      query: {
        focusSessions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: mockInsertPendingProposal,
    // P1 provenance hoist: `evaluatePermission` now resolves the agent session
    // and the project lens on the COMMON path, so a total mock of
    // `@synap/database` must name them or every governed write throws.
    resolveAgentProposalSessionOnce: vi.fn().mockResolvedValue(null),
    resolveOrCreateAgentProposalSession: vi.fn().mockResolvedValue(null),
    deriveAgentProposalSessionGoal: vi.fn(() => "goal"),
    deriveProposalProjectId: vi.fn(
      async (i: { projectId?: string | null }) => i.projectId ?? null
    ),
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

// PARTIAL — `permission-check.ts` also imports `resolveOriginTrust` from this
// specifier and this factory never named it. Unreached by these fixtures today,
// live gap tomorrow.
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
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

import { previewPermissionDecision as previewPermissionDecisionStrict } from "./permission-check.js";
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

const previewPermissionDecision = (opts: OffVocabularyOpts) =>
  previewPermissionDecisionStrict(opts as unknown as PermissionCheckOpts);

const BASE = {
  userId: "user-abc",
  agentUserId: "agent-7",
  workspaceId: "ws-123",
  source: "ai" as const,
};

describe("checkPermissionOrPropose → resolver: the document a document/update targets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockGov.mockResolvedValue({ decision: "propose", reason: "r" });
  });

  it("a document/update passes its data.id as subjectDocumentId", async () => {
    await previewPermissionDecision({
      ...BASE,
      subjectType: "document",
      action: "update",
      data: { id: "doc-1", documentId: "doc-1", ops: [] },
    });
    expect(mockGov).toHaveBeenCalledTimes(1);
    expect(mockGov.mock.calls[0]![0]).toMatchObject({
      subjectType: "document",
      action: "update",
      subjectDocumentId: "doc-1",
    });
  });

  it("an entity/update passes none", async () => {
    await previewPermissionDecision({
      ...BASE,
      subjectType: "entity",
      action: "update",
      data: { id: "ent-1" },
    });
    expect(mockGov.mock.calls[0]![0].subjectDocumentId).toBeUndefined();
  });
});
