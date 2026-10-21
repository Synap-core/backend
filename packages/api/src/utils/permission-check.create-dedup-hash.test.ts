/**
 * Two identical agent entity creates must hash EQUAL, so the second is deduped
 * onto the first pending proposal.
 *
 * MEASURED DEFECT (live, 2026-10-18): three byte-identical "Synap messaging"
 * decision creates (63d6e707, fe1a3ebd, ee5fd394) were filed as three pending
 * rows. `computeProposalDedupHash` stripped the minted id only at the TOP level,
 * while this door stores the record one level down — `{ requestId, changeType,
 * data: { id, title, … } }` — so the nested `data.data.id` (`entities.create`
 * mints `proposedEntityId ?? randomUUID()` per attempt) made every hash unique.
 * The database unit tests hand-built a FLAT `data: { id }`, a shape this door
 * never sends, and stayed green.
 *
 * Seam: the row `checkPermissionOrPropose` hands the ONE pending insert — the
 * `data` the stored `dedup_hash` is computed from — hashed by the REAL
 * `computeProposalDedupHash`. Engine and write seams mocked as in
 * `permission-check.policy-reason-not-stored.test.ts`.
 *
 * Rows that rule out a wrong rule:
 *  - same record, fresh id per attempt ⇒ EQUAL (the defect: unequal);
 *  - same envelope, different title ⇒ UNEQUAL (rules out "strip the whole
 *    nested record");
 *  - same record, different nested `properties.summary` ⇒ UNEQUAL (rules out
 *    "strip the volatile envelope keys at every depth" — `summary` is a
 *    volatile ENVELOPE key but a real record field);
 *  - an UPDATE of two different targets ⇒ UNEQUAL (the nested strip is for
 *    creates only; an update's target is its identity).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGov, mockVerifyPermission, mockInsertPendingProposal, mockValues } =
  vi.hoisted(() => ({
    mockGov: vi.fn(),
    mockVerifyPermission: vi.fn(),
    mockInsertPendingProposal: vi.fn(),
    mockValues: vi.fn(),
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

import { computeProposalDedupHash } from "@synap/database";
import { checkPermissionOrPropose } from "./permission-check.js";

/** The gate `data` `entities.create` builds (routers/entities/create.ts). */
const record = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  profileSlug: "decision",
  title: "Synap messaging: the data layer every app and AI plugs into",
  properties: {
    summary: "Lead with usefulness.",
    decisionStatus: "accepted",
  },
  global: false,
  resolvedWorkspaceId: null,
  ...over,
});

/** File one agent write through the real door; return the stored row's hash. */
async function fileAndHash(write: {
  action: "create" | "update";
  data: Record<string, unknown>;
}): Promise<string> {
  mockInsertPendingProposal.mockClear();
  await checkPermissionOrPropose({
    userId: "user-abc",
    agentUserId: "agent-7",
    workspaceId: "ws-123",
    subjectType: "entity",
    action: write.action,
    source: "intelligence",
    data: write.data,
  });
  expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
  const row = mockInsertPendingProposal.mock.calls[0]![0] as {
    workspaceId: string | null;
    proposalType: string;
    targetType: string;
    targetId: string;
    data: Record<string, unknown>;
  };
  // Non-vacuity: the row IS the request envelope with the record nested.
  expect(row.data).toMatchObject({
    changeType: write.action,
    data: { id: write.data.id },
  });
  return computeProposalDedupHash(row);
}

describe("an agent entity create's dedup hash, from the door's real envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "receipt-1" }]),
    });
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "proposal-1" },
      deduped: false,
    });
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockGov.mockResolvedValue({
      decision: "propose",
      reason: "A person approves this.",
      reasonCode: "DEFAULT_PROPOSE",
    });
  });

  it("the same record filed twice with fresh minted ids hashes EQUAL", async () => {
    const a = await fileAndHash({
      action: "create",
      data: record("e46cc349-e7c5-4c4a-a9e9-f5dcb2778851"),
    });
    const b = await fileAndHash({
      action: "create",
      data: record("0f1b7a52-3c11-4d7e-9b51-1f0d8e3a2c44"),
    });
    expect(a).toBe(b);
  });

  it("a different title hashes UNEQUAL", async () => {
    const a = await fileAndHash({ action: "create", data: record("id-a") });
    const b = await fileAndHash({
      action: "create",
      data: record("id-b", { title: "Another decision" }),
    });
    expect(a).not.toBe(b);
  });

  it("a different nested `summary` property hashes UNEQUAL", async () => {
    const a = await fileAndHash({ action: "create", data: record("id-a") });
    const b = await fileAndHash({
      action: "create",
      data: record("id-b", {
        properties: {
          summary: "Lead with ambition.",
          decisionStatus: "accepted",
        },
      }),
    });
    expect(a).not.toBe(b);
  });

  it("an UPDATE keeps its target in the hash", async () => {
    const a = await fileAndHash({
      action: "update",
      data: { id: "entity-1", title: "Rename" },
    });
    const b = await fileAndHash({
      action: "update",
      data: { id: "entity-2", title: "Rename" },
    });
    expect(a).not.toBe(b);
  });
});
