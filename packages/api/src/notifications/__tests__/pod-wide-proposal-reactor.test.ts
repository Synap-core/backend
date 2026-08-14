/**
 * The event-driven pod-wide proposal fan-out + its idempotency guard.
 *
 * Two invariants are load-bearing and invisible to `tsc`:
 *
 * 1. SCOPE — the reactor must fan out ONLY for `workspaceId === null` rows. A
 *    workspace proposal already notifies through `NotificationService.fromProposal`
 *    (`notifyProposalCreated`), so a reactor that fired for it would double every
 *    workspace bell item in the pod.
 *
 * 2. IDEMPOTENCY — pod-wide proposals reach `notifyPodWideProposal` TWICE (the
 *    direct caller AND this reactor, off the same `proposal.created` emit). The
 *    guard is a per-recipient existence check on the durable notification row,
 *    so it holds in EITHER order and at ANY delay — these tests assert exactly
 *    that, never an ordering.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockProposalFindFirst,
  mockNotificationFindMany,
  mockResolvePodAdmins,
  mockFromPodWideProposal,
} = vi.hoisted(() => ({
  mockProposalFindFirst: vi.fn(),
  mockNotificationFindMany: vi.fn(),
  mockResolvePodAdmins: vi.fn(),
  mockFromPodWideProposal: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        proposals: { findFirst: mockProposalFindFirst },
        notifications: { findMany: mockNotificationFindMany },
      },
    },
  };
});

vi.mock("@synap/events", () => ({ registerReactor: vi.fn() }));

vi.mock("../../services/capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: mockResolvePodAdmins,
}));

vi.mock("../NotificationService.js", () => ({
  NotificationService: { fromPodWideProposal: mockFromPodWideProposal },
}));

const { podWideProposalNotifyReactor } =
  await import("../pod-wide-proposal-reactor.js");
const { notifyPodWideProposal } =
  await import("../notify-pod-wide-proposal.js");

const PROPOSAL_ID = "11111111-1111-1111-1111-111111111111";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    subjectType: "proposal",
    action: "created",
    subjectId: PROPOSAL_ID,
    userId: "user-1",
    ...overrides,
  } as Parameters<typeof podWideProposalNotifyReactor.handler>[0];
}

function podWideRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL_ID,
    workspaceId: null,
    status: "pending",
    targetType: "governance",
    proposalType: "governance.widen_lane",
    agentUserId: null,
    data: { agentUserId: "agent-9", targetPattern: "entity.create" },
    ...overrides,
  };
}

const deps = { boss: {} as never };

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePodAdmins.mockResolvedValue(["owner-1", "admin-2"]);
  mockNotificationFindMany.mockResolvedValue([]);
});

describe("podWideProposalNotifyReactor.match", () => {
  it("matches proposal.created only", () => {
    expect(podWideProposalNotifyReactor.match?.(payload())).toBe(true);
    expect(
      podWideProposalNotifyReactor.match?.(payload({ action: "approved" }))
    ).toBe(false);
    expect(
      podWideProposalNotifyReactor.match?.(payload({ subjectType: "entity" }))
    ).toBe(false);
  });
});

describe("podWideProposalNotifyReactor.handler", () => {
  it("fans out to pod admins for a pending pod-wide proposal", async () => {
    mockProposalFindFirst.mockResolvedValue(podWideRow());

    await podWideProposalNotifyReactor.handler(payload(), deps);

    expect(mockFromPodWideProposal).toHaveBeenCalledTimes(1);
    const arg = mockFromPodWideProposal.mock.calls[0][0];
    expect(arg.proposalId).toBe(PROPOSAL_ID);
    // Dotted proposalType is already fully qualified — never re-prefixed.
    expect(arg.proposalType).toBe("governance.widen_lane");
    expect(arg.description).toContain("entity.create");
    // Governance rows carry the subject agent in data, not agent_user_id.
    expect(arg.agentUserId).toBe("agent-9");
    expect(arg.recipientUserIds).toEqual(["owner-1", "admin-2"]);
  });

  it("composes ${targetType}.${proposalType} for a bare verb", async () => {
    mockProposalFindFirst.mockResolvedValue(
      podWideRow({ targetType: "entity", proposalType: "create", data: {} })
    );

    await podWideProposalNotifyReactor.handler(payload(), deps);

    expect(mockFromPodWideProposal.mock.calls[0][0].proposalType).toBe(
      "entity.create"
    );
  });

  it("does NOT fan out for a workspace-scoped proposal", async () => {
    mockProposalFindFirst.mockResolvedValue(
      podWideRow({ workspaceId: "ws-1" })
    );

    await podWideProposalNotifyReactor.handler(payload(), deps);

    expect(mockFromPodWideProposal).not.toHaveBeenCalled();
  });

  it("does NOT fan out for an already-decided proposal", async () => {
    mockProposalFindFirst.mockResolvedValue(podWideRow({ status: "approved" }));

    await podWideProposalNotifyReactor.handler(payload(), deps);

    expect(mockFromPodWideProposal).not.toHaveBeenCalled();
  });

  it("does NOT throw when the proposal row is gone", async () => {
    mockProposalFindFirst.mockResolvedValue(undefined);

    await expect(
      podWideProposalNotifyReactor.handler(payload(), deps)
    ).resolves.toBeUndefined();
    expect(mockFromPodWideProposal).not.toHaveBeenCalled();
  });
});

describe("notifyPodWideProposal idempotency", () => {
  it("skips entirely when every admin was already notified", async () => {
    mockNotificationFindMany.mockResolvedValue([
      { userId: "owner-1" },
      { userId: "admin-2" },
    ]);

    await notifyPodWideProposal({
      proposalId: PROPOSAL_ID,
      proposalType: "governance.widen_lane",
    });

    expect(mockFromPodWideProposal).not.toHaveBeenCalled();
  });

  it("repairs a PARTIAL fan-out — notifies only the missing recipient", async () => {
    mockNotificationFindMany.mockResolvedValue([{ userId: "owner-1" }]);

    await notifyPodWideProposal({
      proposalId: PROPOSAL_ID,
      proposalType: "governance.widen_lane",
    });

    expect(mockFromPodWideProposal).toHaveBeenCalledTimes(1);
    expect(mockFromPodWideProposal.mock.calls[0][0].recipientUserIds).toEqual([
      "admin-2",
    ]);
  });

  it("is order-independent: the reactor after a direct caller is a no-op", async () => {
    mockProposalFindFirst.mockResolvedValue(podWideRow());

    // Direct caller (e.g. recommend-tighten / notifyProposalCreated) lands first.
    await notifyPodWideProposal({
      proposalId: PROPOSAL_ID,
      proposalType: "governance.widen_lane",
    });
    expect(mockFromPodWideProposal).toHaveBeenCalledTimes(1);

    // Its rows are now durable — the reactor's later pass finds them.
    mockNotificationFindMany.mockResolvedValue([
      { userId: "owner-1" },
      { userId: "admin-2" },
    ]);
    await podWideProposalNotifyReactor.handler(payload(), deps);

    expect(mockFromPodWideProposal).toHaveBeenCalledTimes(1);
  });

  it("never throws when the recipient lookup fails (non-fatal)", async () => {
    mockResolvePodAdmins.mockRejectedValue(new Error("db down"));

    await expect(
      notifyPodWideProposal({
        proposalId: PROPOSAL_ID,
        proposalType: "governance.widen_lane",
      })
    ).resolves.toBeUndefined();
  });
});
