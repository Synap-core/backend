/**
 * B4 (2026-10-21) — a RECEIPT is per (client, project), at the gate.
 *
 * The receipt an agent write is filed under used to be keyed on the client
 * alone, so one conversation's receipt swallowed every project's writes (live:
 * 142 writes, six spaces). The gate now picks the receipt by the write's
 * project (explicit, else the conversation's focus), and a receipt the MCP door
 * DERIVED is re-keyed when the write is about another project. A session the
 * client STARTED (derived without a receipt marker) or NAMED is never split.
 * Every filing is recorded in the request ledger the MCP reply reads.
 *
 * Drives the real `checkPermissionOrPropose` and the real request context
 * (`runWithDerivedSession`, `runWithWriteSessionLedger`); the receipt resolver
 * itself is mocked (its own PGlite suite proves the (client, project) key).
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
// Returns a promise: notifyProposalCreatedOrdered chains .catch on it.
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { fromProposal: vi.fn().mockResolvedValue(undefined) },
}));
// The real module underneath: @synap/database's import graph extends its
// error classes (workspace-identity.ts: `extends ConflictError`).
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));
// The real module underneath: the gate's import graph reads its enums
// (routers/views.ts: `ViewTypeEnum`) at module load.
vi.mock("@synap-core/types", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLikelyUUID: vi.fn(() => false),
}));
const { mockFocusProject } = vi.hoisted(() => ({
  mockFocusProject: vi.fn(),
}));
vi.mock("../services/agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: mockFocusProject,
}));

import { checkPermissionOrPropose as strict } from "./permission-check.js";
import {
  runWithDerivedSession,
  runWithWriteSessionLedger,
} from "@synap/database";
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

const AGENT = {
  userId: "user-abc",
  agentUserId: "agent-1",
  workspaceId: "ws-123",
  subjectType: "entity",
  action: "create",
  data: { id: "ent-xyz", title: "My Entity" },
} as const;

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const FOCUS = "33333333-3333-4333-8333-333333333333";

/** The project the gate keyed the receipt by. */
const keyedBy = () =>
  (mockResolveSessionOnce.mock.calls.at(-1)?.[0] as { projectId?: unknown })
    ?.projectId;

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyPermission.mockResolvedValue({ allowed: true });
  mockResolveSessionOnce.mockResolvedValue("sess-for-project");
  mockDeriveProjectId.mockResolvedValue(null);
  mockFocusProject.mockResolvedValue(null);
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "prop-1" },
    deduped: false,
  });
  setupAgentSelectSequence({});
});

describe("the gate keys a receipt by the write's project", () => {
  it("no session: the explicit project keys the receipt, and the filing is recorded", async () => {
    const { ledger, result } = runWithWriteSessionLedger(() =>
      gate({ ...AGENT, projectId: P2 })
    );
    await result;
    expect(keyedBy()).toBe(P2);
    expect(ledger.filings).toEqual([
      { sessionId: "sess-for-project", projectId: P2 },
    ]);
  });

  it("no session, no explicit project: the conversation's FOCUS keys it", async () => {
    mockFocusProject.mockResolvedValue(FOCUS);
    await gate({ ...AGENT });
    expect(keyedBy()).toBe(FOCUS);
  });

  it("a DERIVED receipt of another project is re-keyed to this project's receipt", async () => {
    await runWithDerivedSession(
      "receipt-p1",
      () => gate({ ...AGENT, sessionId: "receipt-p1", projectId: P2 }),
      { projectId: P1 }
    );
    expect(keyedBy()).toBe(P2);
    expect(receiptRow()).toMatchObject({ sessionId: "sess-for-project" });
  });

  it("CONTROL — a derived receipt of the SAME project is kept", async () => {
    await runWithDerivedSession(
      "receipt-p1",
      () => gate({ ...AGENT, sessionId: "receipt-p1", projectId: P1 }),
      { projectId: P1 }
    );
    expect(mockResolveSessionOnce).not.toHaveBeenCalled();
    expect(receiptRow()).toMatchObject({ sessionId: "receipt-p1" });
  });

  it("a session the client STARTED (derived, no receipt marker) never splits", async () => {
    await runWithDerivedSession("started-1", () =>
      gate({ ...AGENT, sessionId: "started-1", projectId: P2 })
    );
    expect(mockResolveSessionOnce).not.toHaveBeenCalled();
    expect(receiptRow()).toMatchObject({ sessionId: "started-1" });
  });

  it("a session the caller NAMED never splits, even inside a receipt context", async () => {
    await runWithDerivedSession(
      "receipt-p1",
      () =>
        gate({
          ...AGENT,
          sessionId: "receipt-p1",
          sessionSource: "explicit",
          projectId: P2,
        }),
      { projectId: P1 }
    );
    expect(mockResolveSessionOnce).not.toHaveBeenCalled();
    expect(receiptRow()).toMatchObject({ sessionId: "receipt-p1" });
  });
});
