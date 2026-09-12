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
  governanceRow,
  updatedSets,
  mockTxUpdate,
  mockFindFirst,
} = vi.hoisted(() => ({
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
  mockValues: vi.fn(),
  mockReturning: vi.fn(),
  mockGov: vi.fn(),
  mockVerifyPermission: vi.fn().mockResolvedValue({ allowed: true }),
  // The session row `satisfyExpectedOutputs` locks FOR UPDATE.
  sessionRow: { current: [] as unknown[] },
  // The session row the GATE reads (`loadSessionGovernanceContext`) to derive
  // force-propose governance and the slot claim. A different read from the
  // locked one above, so it is mocked separately on purpose.
  governanceRow: { current: undefined as unknown },
  mockFindFirst: vi.fn(),
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
        focusSessions: { findFirst: mockFindFirst },
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

/** What the gate's own session read returns — metadata + the declared slots. */
const declares = (outputs: unknown[]) => ({
  metadata: null,
  expectedOutputs: outputs,
});

/** The receipt row the gate inserted, as the mock captured it. */
const receiptData = () =>
  (
    mockValues.mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined
  )?.data;

describe("auto-approve satisfies the session's expected outputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updatedSets.length = 0;
    sessionRow.current = [];
    governanceRow.current = undefined;
    mockFindFirst.mockImplementation(async () => governanceRow.current);
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

  it("a claimed slot is stamped over the first of its kind, and stored on the receipt", async () => {
    // THE LIVE DEFECT: two owed documents. `data.title` names the SECOND one
    // exactly, so that is the deliverable this approval is evidence for.
    const slots = [
      { kind: "document", label: "Spec" },
      { kind: "document", label: "Summary" },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose({
      ...OPTS,
      data: { id: "doc-xyz", title: "Summary" },
    });

    // The claim is durable on the receipt, not merely a local.
    expect(receiptData()).toMatchObject({ expectedLabel: "Summary" });

    const written = updatedSets[0]!.expectedOutputs as Record<
      string,
      unknown
    >[];
    expect(written[1]).toMatchObject({
      label: "Summary",
      status: "done",
      satisfiedByProposalId: "receipt-1",
    });
    expect(written[0]).not.toHaveProperty("status");
  });

  it("stores the DECLARED casing, matching case-insensitively", async () => {
    const slots = [{ kind: "document", label: "Summary" }];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose({
      ...OPTS,
      data: { id: "doc-xyz", title: "  summary " },
    });

    expect(receiptData()).toMatchObject({ expectedLabel: "Summary" });
  });

  it("writes NO claim when the change names no declared slot — a claim is never invented", async () => {
    const slots = [
      { kind: "document", label: "Spec" },
      { kind: "document", label: "Summary" },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose({
      ...OPTS,
      data: { id: "doc-xyz", title: "Untitled draft" },
    });

    expect(receiptData()).not.toHaveProperty("expectedLabel");
    // …and the kind guess still applies, unchanged.
    const written = updatedSets[0]!.expectedOutputs as Record<
      string,
      unknown
    >[];
    expect(written[0]).toMatchObject({ label: "Spec", status: "done" });
  });

  it("writes no claim when a PARTIAL name overlaps a slot — exact match only", async () => {
    const slots = [{ kind: "document", label: "Summary" }];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose({
      ...OPTS,
      data: { id: "doc-xyz", title: "Summary of the call" },
    });

    expect(receiptData()).not.toHaveProperty("expectedLabel");
  });

  it("IGNORES a caller-supplied data.expectedLabel — only governance may claim a slot", async () => {
    // The receipt spreads the gate `data` FLAT, so an agent that put
    // `expectedLabel` in its own payload would land it on exactly the key
    // `readProposalExpectedLabel` reads back at approval — naming its own
    // deliverable. The claim is resolved from the SESSION ROW or not at all.
    const slots = [
      { kind: "document", label: "Spec" },
      { kind: "document", label: "Summary" },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose({
      ...OPTS,
      data: {
        id: "doc-xyz",
        title: "Untitled draft",
        expectedLabel: "Summary",
      },
    });

    expect(receiptData()).not.toHaveProperty("expectedLabel");
    // …and the stamp fell to the kind rung, not to the agent's own claim.
    const written = updatedSets[0]!.expectedOutputs as Record<
      string,
      unknown
    >[];
    expect(written[0]).toMatchObject({ label: "Spec", status: "done" });
    expect(written[1]).not.toHaveProperty("status");
  });

  it("a RESOLVED claim still wins over a caller-supplied one", async () => {
    const slots = [
      { kind: "document", label: "Spec" },
      { kind: "document", label: "Summary" },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose({
      ...OPTS,
      // The name resolves "Summary"; the caller asks for "Spec" and is ignored.
      data: { id: "doc-xyz", title: "Summary", expectedLabel: "Spec" },
    });

    expect(receiptData()).toMatchObject({ expectedLabel: "Summary" });
  });

  it("writes NO claim when the named slot is of another KIND", async () => {
    // A document write whose title happens to equal a declared ENTITY slot's
    // label. Claiming it would assert this change is that deliverable, and the
    // selector would then refuse it anyway — a claim the approval cannot honour
    // is worse than none.
    const slots = [
      { kind: "entity", label: "Client record" },
      { kind: "document", label: "Spec" },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose({
      ...OPTS,
      data: { id: "doc-xyz", title: "Client record" },
    });

    expect(receiptData()).not.toHaveProperty("expectedLabel");
    // Falls to the kind rung: the document slot, untouched by the label.
    const written = updatedSets[0]!.expectedOutputs as Record<
      string,
      unknown
    >[];
    expect(written[1]).toMatchObject({ label: "Spec", status: "done" });
    expect(written[0]).not.toHaveProperty("status");
  });

  it("leaves outputs of another kind alone", async () => {
    sessionRow.current = openSessionWith([
      { kind: "entity", label: "Client record" },
    ]);

    await checkPermissionOrPropose(OPTS);

    expect(updatedSets).toHaveLength(0);
  });

  /**
   * THE SEAM: the gate must hand the ENTITY'S PROFILE to the stamper, not just
   * the generic `entity` target type. Live defect (2026-09-12): three applied
   * knowledge captures left a `kind: "knowledge"` slot pending forever.
   * Driven through the real gate + the real `satisfyExpectedOutputs`, so
   * dropping the projection in either half fails here.
   */
  it("a knowledge ENTITY satisfies a kind:'knowledge' slot", async () => {
    sessionRow.current = openSessionWith([
      { kind: "task", label: "Follow-up" },
      { kind: "knowledge", label: "Lesson" },
    ]);

    await checkPermissionOrPropose({
      ...OPTS,
      subjectType: "entity",
      data: { id: "ent-1", profileSlug: "knowledge", title: "A lesson" },
    });

    expect(updatedSets).toHaveLength(1);
    const written = updatedSets[0]!.expectedOutputs as Record<
      string,
      unknown
    >[];
    expect(written[1]).toMatchObject({
      label: "Lesson",
      status: "done",
      satisfiedByProposalId: "receipt-1",
    });
    // The task slot is a DIFFERENT deliverable and stays owed.
    expect(written[0]).not.toHaveProperty("status");
  });

  it("a knowledge ENTITY leaves a kind:'task' slot owed", async () => {
    sessionRow.current = openSessionWith([
      { kind: "task", label: "Follow-up" },
    ]);

    await checkPermissionOrPropose({
      ...OPTS,
      subjectType: "entity",
      data: { id: "ent-1", profileSlug: "knowledge", title: "A lesson" },
    });

    expect(updatedSets).toHaveLength(0);
  });

  it("a kind:'entity' slot still behaves as today", async () => {
    sessionRow.current = openSessionWith([
      { kind: "entity", label: "Client record" },
    ]);

    await checkPermissionOrPropose({
      ...OPTS,
      subjectType: "entity",
      data: { id: "ent-1", profileSlug: "knowledge", title: "A lesson" },
    });

    const written = updatedSets[0]!.expectedOutputs as Record<
      string,
      unknown
    >[];
    expect(written[0]).toMatchObject({
      label: "Client record",
      status: "done",
    });
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
