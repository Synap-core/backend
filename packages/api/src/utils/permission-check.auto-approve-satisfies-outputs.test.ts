import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The AUTO-APPROVED half of the honest-deliverable rule.
 *
 * `apply-approval.ts` stamps a session's `expectedOutputs[].status = "done"`
 * when a human approves a pending session proposal. Auto-approve is the other
 * approval path — a governance rule standing in for the click — and it minted a
 * session (the P1 provenance hoist) but never stamped, so every deliverable
 * produced by an auto-approved agent write stayed `pending` forever.
 *
 * These drive the REAL `satisfyExpectedOutputs` (not a spy on it) through a
 * transaction-shaped mock, so what is asserted is the row that would be written
 * — status + lineage — not merely that a function was called.
 *
 * DB-free — every I/O module is mocked.
 */

const {
  mockDbInsert,
  mockDbSelect,
  mockValues,
  mockReturning,
  mockGov,
  mockVerifyPermission,
  sessionRow,
  updatedSets,
  mockTxUpdate,
} = vi.hoisted(() => ({
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
  mockValues: vi.fn(),
  mockReturning: vi.fn(),
  mockGov: vi.fn(),
  mockVerifyPermission: vi.fn().mockResolvedValue({ allowed: true }),
  // The session row `satisfyExpectedOutputs` locks FOR UPDATE.
  sessionRow: { current: [] as unknown[] },
  // Everything the door writes back, in order.
  updatedSets: [] as Record<string, unknown>[],
  mockTxUpdate: vi.fn(),
}));

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

  // A transaction whose `select(...).from(...).where(...).for("update")`
  // resolves the session row, and whose `update(...).set(...)` records the
  // write. That is the whole surface `satisfyExpectedOutputs` touches.
  const tx = {
    insert: mockDbInsert,
    select: () => {
      const b: Record<string, unknown> = {
        from: () => b,
        where: () => b,
        for: () => Promise.resolve(sessionRow.current),
      };
      return b;
    },
    update: mockTxUpdate,
  };

  mockTxUpdate.mockImplementation(() => ({
    set: (patch: Record<string, unknown>) => {
      updatedSets.push(patch);
      return { where: () => Promise.resolve(undefined) };
    },
  }));

  return {
    ...actual,
    db: {
      insert: mockDbInsert,
      select: mockDbSelect,
      transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
      query: {
        focusSessions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: vi.fn(),
    resolveAgentProposalSessionOnce: vi.fn().mockResolvedValue(null),
    resolveOrCreateAgentProposalSession: vi.fn().mockResolvedValue(null),
    deriveAgentProposalSessionGoal: vi.fn(() => "goal"),
    deriveProposalProjectId: vi.fn(
      async (i: { projectId?: string | null }) => i.projectId ?? null
    ),
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
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

vi.mock("@synap/jobs", () => ({
  broadcastNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { fromProposal: vi.fn().mockResolvedValue(undefined) },
}));

import { checkPermissionOrPropose as strict } from "./permission-check.js";
import type { PermissionCheckOpts } from "./permission-check.js";

type OffVocabularyOpts = Omit<PermissionCheckOpts, "subjectType" | "action"> & {
  subjectType: string;
  action: string;
};
const checkPermissionOrPropose = (opts: OffVocabularyOpts) =>
  strict(opts as unknown as PermissionCheckOpts);

const SESSION = "22222222-2222-2222-2222-222222222222";

const OPTS = {
  userId: "user-abc",
  agentUserId: "agent-7",
  workspaceId: "ws-123",
  subjectType: "document",
  action: "create",
  source: "ai" as const,
  data: { id: "doc-xyz", title: "Spec" },
  sessionId: SESSION,
};

const openSessionWith = (outputs: unknown[]) => [
  { expectedOutputs: outputs, status: "active", closedAt: null },
];

describe("auto-approve satisfies the session's expected outputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updatedSets.length = 0;
    sessionRow.current = [];
    mockReturning.mockResolvedValue([{ id: "receipt-1" }]);
    mockValues.mockReturnValue({ returning: mockReturning });
    mockDbInsert.mockImplementation(() => ({ values: mockValues }));
    mockTxUpdate.mockImplementation(() => ({
      set: (patch: Record<string, unknown>) => {
        updatedSets.push(patch);
        return { where: () => Promise.resolve(undefined) };
      },
    }));
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockGov.mockResolvedValue({
      decision: "execute",
      explicitAutoApproveFor: ["document.create"],
    });
  });

  it("stamps the matching output done, with the receipt as lineage", async () => {
    sessionRow.current = openSessionWith([
      { kind: "document", label: "Spec" },
      { kind: "entity", label: "Client record" },
    ]);

    await expect(checkPermissionOrPropose(OPTS)).resolves.toEqual({
      granted: true,
      autoApprovedProposalId: "receipt-1",
    });

    expect(updatedSets).toHaveLength(1);
    const written = updatedSets[0]!.expectedOutputs as Record<
      string,
      unknown
    >[];
    expect(written[0]).toMatchObject({
      label: "Spec",
      status: "done",
      // Falsifiable: the stamp names the receipt row that earned it.
      satisfiedByProposalId: "receipt-1",
    });
    // One approval is evidence for exactly one deliverable.
    expect(written[1]).not.toHaveProperty("status");
  });

  it("leaves outputs of another kind alone", async () => {
    sessionRow.current = openSessionWith([
      { kind: "entity", label: "Client record" },
    ]);

    await checkPermissionOrPropose(OPTS);

    expect(updatedSets).toHaveLength(0);
  });

  it("does not stamp when the write carries no session", async () => {
    sessionRow.current = openSessionWith([{ kind: "document", label: "Spec" }]);

    await checkPermissionOrPropose({ ...OPTS, sessionId: undefined });

    expect(updatedSets).toHaveLength(0);
  });

  it("does not stamp when the receipt insert failed — no dangling lineage", async () => {
    sessionRow.current = openSessionWith([{ kind: "document", label: "Spec" }]);
    mockReturning.mockRejectedValue(new Error("receipt insert exploded"));

    await expect(checkPermissionOrPropose(OPTS)).resolves.toEqual({
      granted: true,
    });

    expect(updatedSets).toHaveLength(0);
  });

  it("still GRANTS when the stamp itself throws (provenance ≠ user-write failure)", async () => {
    sessionRow.current = openSessionWith([{ kind: "document", label: "Spec" }]);
    mockTxUpdate.mockImplementation(() => {
      throw new Error("stamp exploded");
    });

    await expect(checkPermissionOrPropose(OPTS)).resolves.toEqual({
      granted: true,
      autoApprovedProposalId: "receipt-1",
    });
  });
});
