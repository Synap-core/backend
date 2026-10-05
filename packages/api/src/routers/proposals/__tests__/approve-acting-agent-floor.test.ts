/**
 * THE AGENT BEHIND A HUMAN userId — the approve floor on the tRPC door.
 *
 * On an agent-key door (`/mcp`, Hub callers) `ctx.userId` is the LINKED HUMAN
 * (the key's `linkedUserId` remap, `mcp/http-handler.ts`) and the agent travels
 * only as `ctx.agentUserId`. The agent-class floor read `isAgentPrincipal(
 * ctx.userId)` — a human — so it never fired: an agent driving the tRPC
 * `proposals.approve` / `batchApprove` / `revert` through a hub caller context
 * would approve as the human owner. Unexploited only because no MCP tool calls
 * them (pinned by `mcp-never-approves.tripwire.test.ts`).
 *
 * Driven through the REAL router procedures and the REAL authority ladder;
 * only the DB rows and the post-authority apply step are stubbed. The proposal
 * is the human's own (canonical `data.sourceId` = human), so a pure human ctx
 * is admitted on the owner rung — the ONLY difference between the grant and
 * the refusal is `ctx.agentUserId`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const PROPOSAL_ID = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  users: new Map<
    string,
    { userType: string; createdByUserId: string | null }
  >(),
  proposal: null as Record<string, unknown> | null,
  apply: vi.fn(async () => ({ success: true })),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  let lastEqValue: string | undefined;
  const eq = (col: unknown, val: unknown) => {
    lastEqValue = val as string;
    return actual.eq(col as never, val as never);
  };
  return {
    ...actual,
    eq,
    getWorkspaceMembership: async () => undefined,
    db: {
      query: {
        proposals: { findFirst: async () => h.proposal },
        workspaces: { findFirst: async () => undefined },
        workspaceMembers: { findFirst: async () => undefined },
        users: { findFirst: async () => undefined },
      },
      // `isAgentPrincipal` / agent-creator / workspace-settings selects — all
      // `.select().from().where().limit(1)`.
      select: (shape: Record<string, unknown>) => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              if (Object.hasOwn(shape, "settings")) return [{ settings: {} }];
              const row = h.users.get(lastEqValue ?? "");
              return row ? [row] : [];
            },
          }),
        }),
      }),
    },
  };
});
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../../channels.js", () => ({ channelsRouter: {} }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
// Everything AFTER the authority gate. A refusal must never reach it.
vi.mock("../apply-approval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apply-approval.js")>()),
  applyProposalApproval: h.apply,
}));

const { proposalsRouter } = await import("../../proposals.js");

function callerFor(agentUserId: string | null) {
  return proposalsRouter.createCaller({
    authenticated: true,
    userId: HUMAN,
    agentUserId,
    isHubProtocol: agentUserId !== null,
    workspaceId: null,
    req: undefined,
    user: null,
    session: null,
  } as unknown as Parameters<typeof proposalsRouter.createCaller>[0]);
}

beforeEach(() => {
  h.users.clear();
  h.users.set(HUMAN, { userType: "human", createdByUserId: null });
  h.users.set(AGENT, { userType: "agent", createdByUserId: HUMAN });
  h.proposal = {
    id: PROPOSAL_ID,
    workspaceId: WS,
    status: "pending",
    data: { sourceId: HUMAN },
    agentUserId: AGENT,
    targetType: "entity",
    targetId: null,
    sessionId: null,
    proposalType: "create",
    revisionHistory: [],
  };
  h.apply.mockClear();
});

describe("approve — an agent behind a human userId is an agent principal", () => {
  it("REFUSES approve when ctx carries agentUserId (userId = linked human)", async () => {
    await expect(
      callerFor(AGENT).approve({ proposalId: PROPOSAL_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("CONTROL: the same human, no agent in ctx, still approves", async () => {
    await callerFor(null).approve({ proposalId: PROPOSAL_ID });
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("REFUSES each batchApprove item when ctx carries agentUserId", async () => {
    const res = await callerFor(AGENT).batchApprove({
      proposalIds: [PROPOSAL_ID],
    });
    const item = (res as { results: Array<Record<string, unknown>> })
      .results[0];
    expect(item).toMatchObject({ success: false, errorCode: "FORBIDDEN" });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("CONTROL: batchApprove by the pure human applies", async () => {
    await callerFor(null).batchApprove({ proposalIds: [PROPOSAL_ID] });
    expect(h.apply).toHaveBeenCalledTimes(1);
  });

  it("REFUSES revert when ctx carries agentUserId", async () => {
    h.proposal = { ...h.proposal!, status: "approved" };
    await expect(
      callerFor(AGENT).revert({ proposalId: PROPOSAL_ID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
