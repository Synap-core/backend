import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The AUTO-APPROVE RECEIPT — `checkPermissionOrPropose`'s `gov.decision ===
 * "execute"` branch.
 *
 * An auto-approved agent write leaves ONE durable record the user can read back:
 * this row. Two properties it must have, both locked here:
 *
 *   1. JOINABLE — provenance (`correlationId` / `sessionId` / `sourceMessageId`
 *      / `projectId`) written as indexed COLUMNS, not only buried in the `data`
 *      JSONB. Inside JSONB, "what did this agent do in this session" has no
 *      reader; the columns (and their indexes) already existed and went unused.
 *   2. AWAITED — a receipt that races the response is not a receipt: the caller
 *      must not be able to observe a granted write whose audit row does not
 *      exist yet.
 *
 * And one property it must NOT have: an audit-write failure must never fail the
 * user's write.
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
} = vi.hoisted(() => ({
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
  mockValues: vi.fn(),
  // The auto-approve receipt insert now `.returning({ id })`s so its id can be
  // stamped onto the write's `.completed` event (events.proposal_id, 0231).
  mockReturning: vi.fn(),
  mockGov: vi.fn(),
  mockVerifyPermission: vi.fn().mockResolvedValue({ allowed: true }),
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
  return {
    db: {
      insert: mockDbInsert,
      select: mockDbSelect,
      transaction: vi.fn(async (cb: (tx: unknown) => unknown) =>
        cb({ insert: mockDbInsert })
      ),
      query: {
        focusSessions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: vi.fn(),
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
    proposals: {},
    entities: {},
    eq: vi.fn((a: unknown, b: unknown) => ({ field: a, value: b })),
    and: vi.fn((...conds: unknown[]) => ({ and: conds })),
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

vi.mock("@synap/jobs", () => ({
  broadcastNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { fromProposal: vi.fn().mockResolvedValue(undefined) },
}));

import { checkPermissionOrPropose } from "./permission-check.js";

const CORRELATION = "11111111-1111-1111-1111-111111111111";
const SESSION = "22222222-2222-2222-2222-222222222222";
const MESSAGE = "33333333-3333-3333-3333-333333333333";
const PROJECT = "44444444-4444-4444-4444-444444444444";
const REQUESTED_EVENT = "55555555-5555-5555-5555-555555555555";

const OPTS = {
  userId: "user-abc",
  agentUserId: "agent-7",
  workspaceId: "ws-123",
  subjectType: "entity",
  action: "create",
  source: "ai" as const,
  data: { id: "ent-xyz", title: "My Entity" },
  correlationId: CORRELATION,
  requestedEventId: REQUESTED_EVENT,
  sessionId: SESSION,
  sourceMessageId: MESSAGE,
  projectId: PROJECT,
};

describe("checkPermissionOrPropose — auto-approve receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning.mockResolvedValue([{ id: "receipt-1" }]);
    mockValues.mockReturnValue({ returning: mockReturning });
    mockDbInsert.mockImplementation(() => ({ values: mockValues }));
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockGov.mockResolvedValue({
      decision: "execute",
      explicitAutoApproveFor: ["entity.create"],
    });
  });

  it("writes provenance as indexed COLUMNS, not only inside data", async () => {
    const result = await checkPermissionOrPropose(OPTS);

    // The receipt id is threaded back so the caller can stamp it onto the
    // write's `.completed` event (events.proposal_id, 0231).
    expect(result).toEqual({
      granted: true,
      autoApprovedProposalId: "receipt-1",
    });
    expect(mockValues).toHaveBeenCalledTimes(1);

    const row = mockValues.mock.calls[0]![0] as Record<string, unknown>;
    expect(row).toMatchObject({
      workspaceId: "ws-123",
      proposalType: "entity.create",
      status: "auto_approved",
      agentUserId: "agent-7",
      // The point of the repair: these are COLUMNS on `proposals` (all indexed)
      // and they were being written only into `data`.
      correlationId: CORRELATION,
      requestedEventId: REQUESTED_EVENT,
      sessionId: SESSION,
      sourceMessageId: MESSAGE,
      projectId: PROJECT,
    });
  });

  it("threads a VOLUNTEERED reasoning into the receipt payload", async () => {
    await checkPermissionOrPropose({
      ...OPTS,
      reasoning: "The user told me their new address",
    });

    const row = mockValues.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(row.data.reasoning).toBe("The user told me their new address");
  });

  it("omits reasoning entirely when the model volunteered none (never synthesised)", async () => {
    await checkPermissionOrPropose(OPTS);

    const row = mockValues.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(row.data).not.toHaveProperty("reasoning");
  });

  it("AWAITS the receipt — it has landed before the grant is returned", async () => {
    let landed = false;
    // The awaited DB op is now `.values(...).returning(...)` — assert the timing
    // on the returning() promise (the value the code awaits).
    mockReturning.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            landed = true;
            resolve([{ id: "receipt-1" }]);
          }, 5)
        )
    );

    const result = await checkPermissionOrPropose(OPTS);

    // Fire-and-forget would return granted with `landed` still false.
    expect(landed).toBe(true);
    expect(result).toEqual({
      granted: true,
      autoApprovedProposalId: "receipt-1",
    });
  });

  it("still GRANTS the write when the receipt insert throws (audit failure ≠ user-write failure)", async () => {
    mockReturning.mockRejectedValue(new Error("receipt insert exploded"));

    // Grant stands; the receipt id is simply absent (no proposal_id to stamp).
    await expect(checkPermissionOrPropose(OPTS)).resolves.toEqual({
      granted: true,
    });
  });
});
