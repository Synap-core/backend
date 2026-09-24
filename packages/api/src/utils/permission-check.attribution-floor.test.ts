/**
 * D12 — THE ATTRIBUTION FLOOR.
 *
 * MEASURED DEFECT (2026-09-24 audit): `evaluatePermission` opened its AI-policy
 * block with `if (agentUserId)`, and `agentUserId` arrived only as a CALLER-SUPPLIED
 * option. A door that simply omitted it skipped governance-by-kind, instruction
 * provenance — the entire ladder — and the write ran the HUMAN path. For a
 * DEFAULT_AUTO_APPROVE verb that means execute, no proposal. Four verbs shipped that
 * way (`cell.update`, `view.update`, `automation.update`, `profile.propose_retire`)
 * while every guard stayed green, because the risky-verbs tripwire asserts the gate
 * is CALLED, not that attribution REACHES it. Unattributed is not "less governed";
 * it is UNGOVERNED.
 *
 * The fix reads the ambient acting agent first — `runWithActingAgent` is entered
 * server-side at the three key-auth entry points, so it is the one channel a door
 * cannot drop by omission, and the one a caller cannot forge.
 *
 * WHAT THESE TESTS PIN — reachability, not shape. Each drives the REAL resolution
 * through the REAL gate and asserts the DECISION changes: an agent-authenticated
 * write that forwards NO `agentUserId` must still take the agent branch. Asserting
 * the field is merely "declared" is the exact defect class this repo keeps shipping.
 *
 * WHAT THEY CANNOT SEE (measured by writing them, not implied):
 *  - They pin the gate, not the four verb handlers. A handler that never reaches
 *    `checkPermissionOrPropose` at all is invisible here; that is the risky-verbs
 *    tripwire's job.
 *  - They do not prove the three entry points actually enter the scope — that is
 *    `runWithActingAgent`'s own contract, exercised by the hub/mcp suites.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockVerifyPermission,
  mockDbSelect,
  mockDbInsert,
  mockInsertValues,
  mockInsertPendingProposal,
} = vi.hoisted(() => ({
  mockVerifyPermission: vi.fn().mockResolvedValue({ allowed: true }),
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockInsertValues: vi.fn(),
  mockInsertPendingProposal: vi.fn(),
}));

// PARTIAL mock (`importOriginal`) — a total mock dies at COLLECTION time the moment
// permission-check reaches an export the factory forgot, and the whole file goes
// dark rather than one test. It also keeps `runWithActingAgent` /
// `getActingAgentUserId` REAL, which is the entire point: the test and the gate
// must share one AsyncLocalStorage instance.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const { randomUUID } = await import("crypto");
  mockDbInsert.mockImplementation(() => ({
    values: (v: unknown) => {
      mockInsertValues(v);
      return { returning: vi.fn().mockResolvedValue([{ id: randomUUID() }]) };
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
    resolveAgentProposalSessionOnce: vi.fn().mockResolvedValue(null),
    deriveProposalProjectId: vi.fn().mockResolvedValue(null),
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
vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
}));
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

import { runWithActingAgent } from "@synap/database";
import { checkPermissionOrPropose as strict } from "./permission-check.js";
import type { PermissionCheckOpts } from "./permission-check.js";

/** Same off-vocabulary shim the sibling suites document — test-only. */
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

const ACTING_AGENT = "agent-ambient-1";

/** A write that forwards NO agentUserId — the shape the four verbs shipped. */
const UNATTRIBUTED_WRITE = {
  userId: "user-abc",
  workspaceId: "ws-123",
  subjectType: "entity",
  action: "create",
  data: { id: "ent-xyz", title: "My Entity" },
} as const;

/** rung 5 — every agent write proposes, so the branch taken is observable. */
const PROPOSE_METADATA = { writesRequireProposal: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyPermission.mockResolvedValue({ allowed: true });
  // The SSOT insert returns the created row; the gate destructures it.
  mockInsertPendingProposal.mockResolvedValue({
    proposal: { id: "prop-1", status: "pending" },
    deduped: false,
  });
});

describe("D12 — the gate resolves the acting agent from ambient", () => {
  it("governs a write that forwards NO agentUserId, when a key-auth scope is active", async () => {
    setupAgentSelectSequence(PROPOSE_METADATA);

    await runWithActingAgent(ACTING_AGENT, () => gate(UNATTRIBUTED_WRITE));

    // The AGENT branch ran: rung 5 proposes instead of executing.
    expect(mockInsertPendingProposal).toHaveBeenCalled();
    const row = mockInsertPendingProposal.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    // And it is attributed to the ambient agent — not left null, not the human.
    expect(row.agentUserId).toBe(ACTING_AGENT);
  });

  it("CONTROL: the same call with no ambient scope stays on the human path", async () => {
    setupAgentSelectSequence(PROPOSE_METADATA);

    await gate(UNATTRIBUTED_WRITE);

    // No agent principal anywhere ⇒ no agent governance ⇒ no pending proposal.
    // This is the behaviour the four verbs had for every caller, and it is why
    // the first assertion above is about REACHABILITY and not about a field.
    expect(mockInsertPendingProposal).not.toHaveBeenCalled();
  });

  it("a caller cannot re-point attribution: ambient WINS over a supplied id", async () => {
    setupAgentSelectSequence(PROPOSE_METADATA);

    await runWithActingAgent(ACTING_AGENT, () =>
      gate({ ...UNATTRIBUTED_WRITE, agentUserId: "agent-supplied-other" })
    );

    const row = mockInsertPendingProposal.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(row.agentUserId).toBe(ACTING_AGENT);
  });

  it("falls back to the supplied id when there is no request scope (approval replay, jobs)", async () => {
    setupAgentSelectSequence(PROPOSE_METADATA);

    await gate({ ...UNATTRIBUTED_WRITE, agentUserId: "agent-in-process" });

    const row = mockInsertPendingProposal.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(row.agentUserId).toBe("agent-in-process");
  });
});
