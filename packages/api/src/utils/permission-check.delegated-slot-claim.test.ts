import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE DELEGATED SLOT CLAIM — rung 2 of `resolveSessionSlotClaim`.
 *
 * W1 taught governance to write `proposals.data.expectedLabel` when a change's
 * OWN NAME exactly matches a declared deliverable. That rung is deliberately a
 * spelling test, and it fails exactly where it matters most: an agent asked to
 * produce "Summary" writes a draft titled "Call summary — Sept" and the claim
 * evaporates, so the approval falls back to the first-of-kind guess. On a
 * session owing two documents that guess is a coin flip that stamps the WRONG
 * deliverable done — with lineage, which makes it look verified.
 *
 * Rung 2 closes it with the only other thing on the row that names a slot: the
 * DELEGATION. `focusSessions.delegateOutput` records `delegatedTo: <agentType>`
 * when a human hands a slot over, so a write by an agent OF THAT TYPE, in THAT
 * session, is claimed for that slot whatever the artefact is called. The naming
 * happened ahead of time, by a person.
 *
 * The rule's edges are what these pin, because each is a way it could quietly
 * become a guess again:
 *   • a NON-delegated agent gets no help — it still needs the exact name;
 *   • an exact name still WINS over the delegation (rung 1 before rung 2);
 *   • a `done` slot is never re-claimed;
 *   • a DIFFERENT agent type does not inherit someone else's delegation.
 *
 * These drive the REAL gate and read the RECEIPT ROW it inserts, so a claim
 * about `expectedLabel` is a claim about durable data, not a spy call.
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
  agentRow,
  updatedSets,
  mockTxUpdate,
  mockFindFirst,
  mockUserFindFirst,
} = vi.hoisted(() => ({
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
  mockValues: vi.fn(),
  mockReturning: vi.fn(),
  mockGov: vi.fn(),
  mockVerifyPermission: vi.fn().mockResolvedValue({ allowed: true }),
  /** The session row `satisfyExpectedOutputs` locks FOR UPDATE. */
  sessionRow: { current: [] as unknown[] },
  /** The session row the GATE reads to derive governance + the slot claim. */
  governanceRow: { current: undefined as unknown },
  /** The ACTING AGENT's user row — where its `agentType` comes from. */
  agentRow: { current: undefined as unknown },
  mockFindFirst: vi.fn(),
  mockUserFindFirst: vi.fn(),
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
        users: { findFirst: mockUserFindFirst },
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

// PARTIAL, not total: this module also exports `resolveOriginTrust`, which the
// gate calls. A total factory omitting it kills the file at COLLECTION the day
// that call is reached — zero tests run, which reads as a pass in a summary
// (pinned by `__tripwires__/total-mock-missing-export-ratchet.test.ts`).
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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
  // A name that matches NO declared slot — rung 1 is out of the picture, which
  // is precisely the situation rung 2 exists for.
  data: { id: "doc-xyz", title: "Call summary — Sept" },
  sessionId: SESSION,
};

const openSessionWith = (outputs: unknown[]) => [
  { expectedOutputs: outputs, status: "active", closedAt: null },
];
const declares = (outputs: unknown[]) => ({
  metadata: null,
  expectedOutputs: outputs,
});
const receiptData = () =>
  (
    mockValues.mock.calls[0]?.[0] as
      { data: Record<string, unknown> } | undefined
  )?.data;
const writtenOutputs = () =>
  updatedSets[0]?.expectedOutputs as Record<string, unknown>[] | undefined;

/** The slots a delegated session carries: one handed over, one not. */
const DELEGATED_SLOTS = [
  { kind: "document", label: "Spec" },
  { kind: "document", label: "Summary", delegatedTo: "workspace-builder" },
];

beforeEach(() => {
  vi.clearAllMocks();
  updatedSets.length = 0;
  sessionRow.current = [];
  governanceRow.current = undefined;
  agentRow.current = { agentType: "workspace-builder" };
  mockFindFirst.mockImplementation(async () => governanceRow.current);
  mockUserFindFirst.mockImplementation(async () => agentRow.current);
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

describe("a DELEGATED agent claims its slot without naming it", () => {
  it("claims the slot delegated to its own agent type", async () => {
    sessionRow.current = openSessionWith(DELEGATED_SLOTS);
    governanceRow.current = declares(DELEGATED_SLOTS);

    await checkPermissionOrPropose(OPTS);

    // Durable on the receipt, not merely a local.
    expect(receiptData()).toMatchObject({ expectedLabel: "Summary" });
    // …and it is the SECOND slot that gets stamped, not the first-of-kind guess.
    expect(writtenOutputs()![1]).toMatchObject({
      label: "Summary",
      status: "done",
      satisfiedByProposalId: "receipt-1",
    });
    expect(writtenOutputs()![0]).not.toHaveProperty("status");
  });

  it("matches the delegated type case-insensitively", async () => {
    agentRow.current = { agentType: "  Workspace-Builder " };
    sessionRow.current = openSessionWith(DELEGATED_SLOTS);
    governanceRow.current = declares(DELEGATED_SLOTS);

    await checkPermissionOrPropose(OPTS);
    expect(receiptData()).toMatchObject({ expectedLabel: "Summary" });
  });

  it("never re-claims a slot that is already done", async () => {
    const slots = [
      {
        kind: "document",
        label: "Summary",
        delegatedTo: "workspace-builder",
        status: "done",
      },
      { kind: "document", label: "Spec" },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose(OPTS);
    expect(receiptData()).not.toHaveProperty("expectedLabel");
  });
});

describe("a NON-delegated write still needs the exact name", () => {
  it("writes no claim when the acting agent holds no delegation on this session", async () => {
    // Another agent type entirely. Nothing on the row says this write is for
    // "Summary", so inventing a claim would be a guess dressed as evidence —
    // the kind guess still runs, and it stays visibly a guess.
    agentRow.current = { agentType: "crm-hygiene" };
    sessionRow.current = openSessionWith(DELEGATED_SLOTS);
    governanceRow.current = declares(DELEGATED_SLOTS);

    await checkPermissionOrPropose(OPTS);

    expect(receiptData()).not.toHaveProperty("expectedLabel");
    // The unchanged fallback: FIRST not-yet-done slot of the kind.
    expect(writtenOutputs()![0]).toMatchObject({
      label: "Spec",
      status: "done",
    });
  });

  it("writes no claim when the session has no delegation at all", async () => {
    const slots = [
      { kind: "document", label: "Spec" },
      { kind: "document", label: "Summary" },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose(OPTS);
    expect(receiptData()).not.toHaveProperty("expectedLabel");
    // The agent-type lookup is not even reached — no delegated slot to match.
    expect(mockUserFindFirst).not.toHaveBeenCalled();
  });
});

describe("KIND is a floor on BOTH rungs", () => {
  it("rung 2 does not claim a delegated slot of another kind", async () => {
    // The agent was handed an ENTITY slot and is creating a DOCUMENT. The
    // delegation names WHICH deliverable, never WHETHER this change could be
    // one — a claim here would ride the receipt as an assertion the approval
    // path would then refuse to honour.
    const slots = [
      { kind: "document", label: "Spec" },
      {
        kind: "entity",
        label: "Client record",
        delegatedTo: "workspace-builder",
      },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose(OPTS);

    expect(receiptData()).not.toHaveProperty("expectedLabel");
    // The kind rung still applies: the one document slot is stamped.
    expect(writtenOutputs()![0]).toMatchObject({
      label: "Spec",
      status: "done",
    });
    expect(writtenOutputs()![1]).not.toHaveProperty("status");
  });

  it("rung 1 does not claim a same-named slot of another kind", async () => {
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
    expect(writtenOutputs()![1]).toMatchObject({
      label: "Spec",
      status: "done",
    });
  });
});

describe("rung 1 still outranks rung 2", () => {
  it("an exact NAME match wins over the delegation", async () => {
    // The delegation points at "Summary"; the artefact is literally called
    // "Spec". What the change SAYS it is beats what it was asked to be.
    const slots = [
      { kind: "document", label: "Spec" },
      { kind: "document", label: "Summary", delegatedTo: "workspace-builder" },
    ];
    sessionRow.current = openSessionWith(slots);
    governanceRow.current = declares(slots);

    await checkPermissionOrPropose({
      ...OPTS,
      data: { id: "doc-xyz", title: "Spec" },
    });

    expect(receiptData()).toMatchObject({ expectedLabel: "Spec" });
    expect(writtenOutputs()![0]).toMatchObject({
      label: "Spec",
      status: "done",
    });
    expect(writtenOutputs()![1]).not.toHaveProperty("status");
  });
});
