/**
 * P1 — PRODUCER ATTRIBUTION AT THE AUTO-APPROVE DOOR.
 *
 * MEASURED DEFECT (census 2026-09-03, 2961 proposals): `sessionId` was set on
 * 2.6% of rows and `stepRunId` on 0%. The cause was structural, not a bug in any
 * one call: the agent-session mint lived INSIDE the PENDING path
 * (`createPendingProposalRow`), so only PROPOSED agent writes got packaged into
 * a session — while auto-approve is the majority of agent write traffic. The
 * AUTO_APPROVED receipt took `sessionId ?? undefined` raw and, having no
 * upstream producer, wrote NULL essentially always.
 *
 * These tests pin the fix at the row level: the mint is hoisted to the one point
 * BOTH governance branches pass through, so an auto-approved agent write carries
 * the SAME session a proposed one would — and the workflow-attribution columns
 * reach the row on both branches instead of one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockVerifyPermission,
  mockDbSelect,
  mockDbInsert,
  mockInsertValues,
  mockResolveSessionOnce,
  mockDeriveProjectId,
  mockInsertPendingProposal,
} = vi.hoisted(() => ({
  mockVerifyPermission: vi.fn().mockResolvedValue({ allowed: true }),
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  /** Captures the receipt row handed to `db.insert(proposals).values(...)`. */
  mockInsertValues: vi.fn(),
  mockResolveSessionOnce: vi.fn(),
  mockDeriveProjectId: vi.fn(),
  mockInsertPendingProposal: vi.fn(),
}));

// PARTIAL mock (`importOriginal`), not a total replacement: a total mock dies at
// COLLECTION time the moment `permission-check.ts` reaches for an export the
// factory forgot to list — the whole file goes dark rather than one test. The
// package ratchet (`__tripwires__/database-mock-total-ratchet.test.ts`) pins the
// offender count, so a new test must not add one.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const { randomUUID } = await import("crypto");
  mockDbInsert.mockImplementation(() => ({
    values: (v: unknown) => {
      mockInsertValues(v);
      return {
        returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]),
      };
    },
  }));
  return {
    ...actual,
    db: {
      insert: mockDbInsert,
      select: mockDbSelect,
      transaction: vi.fn(async (cb) => cb({ insert: mockDbInsert })),
      query: {
        focusSessions: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: mockInsertPendingProposal,
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
    resolveAgentProposalSessionOnce: mockResolveSessionOnce,
    deriveProposalProjectId: mockDeriveProjectId,
    resolveOrCreateAgentProposalSession: vi.fn().mockResolvedValue(null),
    deriveAgentProposalSessionGoal: vi.fn(() => "Agent create · entity"),
    proposals: {},
    entities: {},
    users: { id: "id", userType: "userType", agentMetadata: "agentMetadata" },
    workspaces: { id: "id", settings: "settings" },
    eq: vi.fn((a, b) => ({ field: a, value: b })),
    and: vi.fn((...conds) => ({ and: conds })),
    inArray: vi.fn((col, arr) => ({ inArray: [col, arr] })),
    gte: vi.fn((a, b) => ({ gte: [a, b] })),
    desc: vi.fn((a) => ({ desc: a })),
    isNotNull: vi.fn((a) => ({ isNotNull: a })),
    drizzleSql: vi.fn(() => ({})),
    verifyPermission: mockVerifyPermission,
    ProposalStatus: { PENDING: "pending", AUTO_APPROVED: "auto_approved" },
    ProfileResolutionService: class {
      resolveProfile = vi.fn().mockResolvedValue({ id: "p1", slug: "task" });
    },
  };
});

vi.mock("./ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@synap/jobs", () => ({
  broadcastNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { fromProposal: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@synap-core/core", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));
vi.mock("@synap-core/types", () => ({ isLikelyUUID: vi.fn(() => false) }));

import { checkPermissionOrPropose as strict } from "./permission-check.js";
import type { PermissionCheckOpts } from "./permission-check.js";

/** Same off-vocabulary shim the sibling suite documents — test-only. */
const gate = (opts: Record<string, unknown>) =>
  strict(opts as unknown as PermissionCheckOpts);

function setupAgentSelectSequence(
  agentMetadata: Record<string, unknown>,
  workspaceSettings: Record<string, unknown> = {}
) {
  let callCount = 0;
  const builder = (limitResult: unknown[]) => {
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn(() => b),
      orderBy: vi.fn(() => b),
      limit: vi.fn().mockResolvedValue(limitResult),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    };
    return b;
  };
  mockDbSelect.mockImplementation(() => {
    callCount++;
    if (callCount === 1)
      return builder([{ userType: "agent", agentMetadata }]) as never;
    return builder([{ settings: workspaceSettings }]) as never;
  });
}

/** The receipt row (the only `proposals` INSERT on the auto-approve branch). */
function receiptRow(): Record<string, unknown> {
  expect(mockInsertValues).toHaveBeenCalled();
  return mockInsertValues.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

/** The PENDING row handed to the shared SSOT insert. */
function pendingRow(): Record<string, unknown> {
  expect(mockInsertPendingProposal).toHaveBeenCalled();
  return mockInsertPendingProposal.mock.calls.at(-1)?.[0] as Record<
    string,
    unknown
  >;
}

const AGENT = {
  userId: "user-abc",
  agentUserId: "agent-1",
  workspaceId: "ws-123",
  subjectType: "entity",
  action: "create",
  data: { id: "ent-xyz", title: "My Entity" },
} as const;

/** `entity.create` is in DEFAULT_AUTO_APPROVE → the ladder returns `execute`. */
const AUTO_APPROVE_METADATA = {};
/** rung 5 — every write proposes. */
const PROPOSE_METADATA = { writesRequireProposal: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyPermission.mockResolvedValue({ allowed: true });
  mockResolveSessionOnce.mockResolvedValue("sess-hoisted");
  mockDeriveProjectId.mockResolvedValue("proj-1");
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "prop-1" },
    deduped: false,
  });
});

describe("auto-approved agent write — session provenance", () => {
  it("carries the hoisted sessionId on the AUTO_APPROVED receipt", async () => {
    setupAgentSelectSequence(AUTO_APPROVE_METADATA);

    const result = await gate({ ...AGENT });

    expect(result).toMatchObject({ granted: true });
    expect(receiptRow()).toMatchObject({
      status: "auto_approved",
      sessionId: "sess-hoisted",
    });
  });

  it("derives the receipt's projectId through the PENDING door's own helper", async () => {
    setupAgentSelectSequence(AUTO_APPROVE_METADATA);

    await gate({ ...AGENT });

    expect(mockDeriveProjectId).toHaveBeenCalledWith({
      projectId: undefined,
      sessionId: "sess-hoisted",
    });
    expect(receiptRow()).toMatchObject({ projectId: "proj-1" });
  });

  it("leaves sessionId unset when no session can be resolved — never invented", async () => {
    setupAgentSelectSequence(AUTO_APPROVE_METADATA);
    mockResolveSessionOnce.mockResolvedValue(null);

    await gate({ ...AGENT });

    expect(receiptRow().sessionId).toBeUndefined();
  });

  it("an EXPLICIT caller session wins and the resolver is never consulted", async () => {
    setupAgentSelectSequence(AUTO_APPROVE_METADATA);

    await gate({ ...AGENT, sessionId: "sess-explicit" });

    expect(mockResolveSessionOnce).not.toHaveBeenCalled();
    expect(receiptRow()).toMatchObject({ sessionId: "sess-explicit" });
  });

  it("never mints for a focus_session subject — the recursion guard", async () => {
    setupAgentSelectSequence(AUTO_APPROVE_METADATA);

    await gate({ ...AGENT, subjectType: "focus_session", action: "update" });

    expect(mockResolveSessionOnce).not.toHaveBeenCalled();
  });

  it("never mints for a DENIED write — a refused write gets no session", async () => {
    setupAgentSelectSequence({ capabilities: ["nothing"] });
    mockVerifyPermission.mockResolvedValue({
      allowed: false,
      reason: "User is not a member of this workspace",
    });

    await gate({ ...AGENT });

    expect(mockResolveSessionOnce).not.toHaveBeenCalled();
  });
});

describe("the mint resolves ONCE per gate call", () => {
  it("execute branch: exactly one resolution, not one per row-write", async () => {
    setupAgentSelectSequence(AUTO_APPROVE_METADATA);

    await gate({ ...AGENT });

    expect(mockResolveSessionOnce).toHaveBeenCalledTimes(1);
  });

  it("propose branch: exactly one resolution — the PENDING door's own mint no-ops", async () => {
    setupAgentSelectSequence(PROPOSE_METADATA);

    await gate({ ...AGENT });

    expect(mockResolveSessionOnce).toHaveBeenCalledTimes(1);
    // The session is already on the row, so `createPendingProposalRow`'s
    // legacy mint short-circuits instead of resolving a second time.
    expect(pendingRow()).toMatchObject({ sessionId: "sess-hoisted" });
  });
});

describe("workflow attribution reaches the row on BOTH branches", () => {
  const ATTRIBUTION = {
    stepRunId: "step-run-9",
    nodeId: "node-4",
    governanceReason: "UNTRUSTED_ORIGIN",
  };

  it("auto-approve receipt persists stepRunId / nodeId / governanceReason", async () => {
    setupAgentSelectSequence(AUTO_APPROVE_METADATA);

    await gate({ ...AGENT, ...ATTRIBUTION });

    expect(receiptRow()).toMatchObject({
      stepRunId: "step-run-9",
      nodeId: "node-4",
      governanceReason: "UNTRUSTED_ORIGIN",
    });
  });

  it("pending proposal persists stepRunId / nodeId", async () => {
    setupAgentSelectSequence(PROPOSE_METADATA);

    await gate({ ...AGENT, ...ATTRIBUTION });

    expect(pendingRow()).toMatchObject({
      stepRunId: "step-run-9",
      nodeId: "node-4",
    });
  });

  it("the ENGINE's own reason code outranks a caller-supplied one", async () => {
    setupAgentSelectSequence(PROPOSE_METADATA);

    await gate({ ...AGENT, governanceReason: "CALLER_SUPPLIED" });

    // rung 5 (writesRequireProposal) stamps its own PROPOSE_REASON key.
    expect(pendingRow().governanceReason).not.toBe("CALLER_SUPPLIED");
  });
});
