/**
 * The ORDERING itself, proven against real write latency.
 *
 * The duplicate bell row is a RACE, not a missing guard: the writer's fan-out
 * and the `proposal.created` reactor both run the idempotency SELECT before
 * either INSERT commits. A fake whose INSERT lands in the same microtask has a
 * zero-width window and would pass against the live defect, so this harness
 * gives the write a deliberate 5 ms cost — the same order as the two rows
 * observed live on 2026-09-12.
 *
 * `emitSideEffects` is stubbed to RUN the pod-wide reactor's own handler, which
 * is what the real one does in-process; the real one bails when pg-boss is
 * unavailable, which would hide the second arm entirely.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROPOSAL = "0eeeeeee-0000-4000-8000-000000000005";
const ADMIN = "0aaaaaaa-0000-4000-8000-000000000001";

const WRITE_LATENCY_MS = 5;

const state = {
  rows: [] as { userId: string; sourceId?: string; type: string }[],
  proposal: null as Record<string, unknown> | null,
};

const fakeDb: any = {
  insert: () => ({
    values: (row: Record<string, unknown>) => ({
      returning: async () => {
        await new Promise((r) => setTimeout(r, WRITE_LATENCY_MS));
        state.rows.push({
          userId: row.userId as string,
          sourceId: row.sourceId as string | undefined,
          type: row.type as string,
        });
        return [{ id: `notif-${state.rows.length}` }];
      },
    }),
  }),
  query: {
    notificationPreferences: { findFirst: async () => undefined },
    notifications: {
      findMany: async () =>
        state.rows
          .filter(
            (r) => r.type === "proposal.created" && r.sourceId === PROPOSAL
          )
          .map((r) => ({ userId: r.userId })),
    },
    proposals: { findFirst: async () => state.proposal },
  },
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: fakeDb,
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("@synap/events", () => ({
  emitSideEffects: async (payload: any) => {
    const { podWideProposalNotifyReactor: reactor } =
      await import("../pod-wide-proposal-reactor.js");
    if (reactor.match?.(payload)) await reactor.handler(payload, {} as never);
  },
  registerReactor: () => {},
}));

vi.mock("../../services/capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: async () => [ADMIN],
}));

vi.mock("../expo-push.js", () => ({ sendExpoPush: async () => {} }));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => {},
}));

const { notifyProposalCreatedOrdered } =
  await import("../notify-proposal-created-ordered.js");

const flush = async () => {
  for (let i = 0; i < 10; i++)
    await new Promise((r) => setTimeout(r, WRITE_LATENCY_MS));
};

beforeEach(() => {
  state.rows = [];
  state.proposal = {
    id: PROPOSAL,
    workspaceId: null,
    status: "pending",
    targetType: "governance",
    proposalType: "governance.tighten",
    agentUserId: null,
    data: {},
  };
});

describe("notifyProposalCreatedOrdered", () => {
  it("tells the admin ONCE even though the emit's reactor lands in the same fan-out", async () => {
    await notifyProposalCreatedOrdered({
      podWide: {
        proposalId: PROPOSAL,
        proposalType: "governance.tighten",
        description: "Pin something to review",
      },
      sideEffect: { subjectId: PROPOSAL, userId: ADMIN, data: {} },
    });
    await flush();

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      userId: ADMIN,
      sourceId: PROPOSAL,
      type: "proposal.created",
    });
  });

  it("a WORKSPACE-scoped caller (podWide: null) writes no pod-wide row", async () => {
    // The reactor re-reads the row and bails on a workspace proposal, so the
    // emit alone must not mint a bell item.
    state.proposal = { ...state.proposal!, workspaceId: "ws-1" };

    await notifyProposalCreatedOrdered({
      podWide: null,
      sideEffect: { subjectId: PROPOSAL, userId: ADMIN, workspaceId: "ws-1" },
    });
    await flush();

    expect(state.rows).toHaveLength(0);
  });

  it("reports an emit failure instead of swallowing it", async () => {
    const onEmitError = vi.fn();
    const events = await import("@synap/events");
    vi.spyOn(events, "emitSideEffects").mockRejectedValueOnce(
      new Error("queue down")
    );

    await notifyProposalCreatedOrdered({
      podWide: null,
      sideEffect: { subjectId: PROPOSAL, userId: ADMIN },
      onEmitError,
    });
    await flush();

    expect(onEmitError).toHaveBeenCalledOnce();
  });
});
