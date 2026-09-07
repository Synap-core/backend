/**
 * MUTATION PROOF (A) — the AUTHOR rung on the shared revise core.
 *
 * `mergeProposalRevision` made exactly ONE authority call —
 * `computeCanReviewApproval` — so an agent could only amend its own pending
 * proposal if it satisfied the HUMAN REVIEWER ladder. It never does (and must
 * not), so `synap_revise_proposal` was closed to the very agent that authored
 * the proposal: it could ask, but never correct what it had asked for.
 *
 * The fix adds an AUTHOR rung — `proposals.agentUserId === actingAgentUserId` —
 * as a SEPARATE branch, mirroring `proposals.withdraw` (routers/proposals.ts:1670),
 * which is likewise proposer-only and explicitly refuses the reviewer ladder.
 *
 * ⛔ The critical invariant these tests pin: the agent id is NEVER fed into
 * `computeCanReviewApproval`. Doing so would make `isOwner` true on the
 * dev-approval doors (where `data.sourceId` IS the agent) and hand the agent
 * full REVIEWER authority over its own proposal. Author ≠ reviewer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalStatus } from "@synap/database";

const h = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  updates: 0,
  allowed: false,
  /** Every userId the REVIEWER ladder was consulted with. */
  reviewCalls: [] as string[],
}));

// PARTIAL mock (see the `database-mock-total-ratchet` tripwire): keep real
// tables/enums/operators, fake only `db.transaction`.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ for: async () => (h.row ? [h.row] : []) }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          h.updates += 1;
        },
      }),
    }),
  };
  return {
    ...actual,
    db: { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) },
  };
});

vi.mock("../../routers/proposals/review-authority.js", () => ({
  computeCanReviewApproval: async (args: { userId: string }) => {
    h.reviewCalls.push(args.userId);
    return { allowed: h.allowed, reason: "not-authorized" };
  },
}));

const { mergeProposalRevision } = await import("./proposals-service.js");

const AGENT = "agent-user-id";
const OTHER_AGENT = "other-agent-user-id";
const HUMAN = "human-user-id";

beforeEach(() => {
  h.updates = 0;
  h.allowed = false; // the reviewer ladder DENIES throughout, unless a test says otherwise
  h.reviewCalls = [];
  h.row = {
    data: { _summary: "before", sourceId: AGENT },
    status: ProposalStatus.PENDING,
    workspaceId: "ws",
    agentUserId: AGENT,
  };
});

describe("THE GAP — without the author rung the authoring agent is locked out", () => {
  it("MUTATION: omitting actingAgentUserId leaves the agent denied (pre-fix behaviour)", async () => {
    // This is exactly what the MCP door did before: it never destructured
    // `agentUserId` from ctx, so the core saw no acting agent and fell to the
    // reviewer ladder — which denies. NOT_FOUND, not FORBIDDEN, so the door
    // cannot be used as an existence oracle.
    await expect(
      mergeProposalRevision({
        proposalId: "p1",
        summary: "after",
        actorId: HUMAN,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.updates).toBe(0);
  });

  it("passing the acting agent id ALLOWS the amendment — the only changed input", async () => {
    await mergeProposalRevision({
      proposalId: "p1",
      summary: "after",
      actorId: HUMAN,
      actingAgentUserId: AGENT,
    });
    expect(h.updates).toBe(1);
  });
});

describe("THE INVARIANT — the agent id never reaches the reviewer ladder", () => {
  it("does NOT consult computeCanReviewApproval at all when the author rung matches", async () => {
    await mergeProposalRevision({
      proposalId: "p1",
      summary: "after",
      actorId: HUMAN,
      actingAgentUserId: AGENT,
    });
    // If this ever contains AGENT, the self-approval trap has been walked into.
    expect(h.reviewCalls).toEqual([]);
  });

  it("consults the ladder with the HUMAN id only, on the non-author path", async () => {
    h.allowed = true;
    await mergeProposalRevision({
      proposalId: "p1",
      summary: "after",
      actorId: HUMAN,
      actingAgentUserId: OTHER_AGENT,
    });
    expect(h.reviewCalls).toEqual([HUMAN]);
    expect(h.reviewCalls).not.toContain(OTHER_AGENT);
  });
});

describe("THE NARROWNESS — the rung authorizes the AUTHOR and nobody else", () => {
  it("a DIFFERENT agent cannot amend this proposal", async () => {
    await expect(
      mergeProposalRevision({
        proposalId: "p1",
        summary: "hijack",
        actorId: HUMAN,
        actingAgentUserId: OTHER_AGENT,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.updates).toBe(0);
  });

  it("a proposal with NO agentUserId is never author-matched (null == null guard)", async () => {
    h.row = { ...h.row, agentUserId: null };
    await expect(
      mergeProposalRevision({
        proposalId: "p1",
        summary: "after",
        actorId: HUMAN,
        actingAgentUserId: null,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.updates).toBe(0);
  });

  it("the author rung does NOT bypass the PENDING guard — a decided proposal still CONFLICTs", async () => {
    // Author authority lets an agent amend what it is ASKING FOR. It must never
    // let it rewrite a proposal a human has already decided.
    h.row = { ...h.row, status: ProposalStatus.APPROVED };
    await expect(
      mergeProposalRevision({
        proposalId: "p1",
        summary: "after the fact",
        actorId: HUMAN,
        actingAgentUserId: AGENT,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.updates).toBe(0);
  });

  it("a human reviewer with real authority is unaffected", async () => {
    h.allowed = true;
    await mergeProposalRevision({
      proposalId: "p1",
      summary: "after",
      actorId: HUMAN,
    });
    expect(h.updates).toBe(1);
  });
});

describe("PATCH reaches the core (so narrative and payload cannot diverge)", () => {
  it("an author agent may amend the PAYLOAD, not just the summary", async () => {
    await mergeProposalRevision({
      proposalId: "p1",
      summary: "now creates Acme Corp",
      patch: { kind: "inner", fields: { name: "Acme Corp" } },
      actorId: HUMAN,
      actingAgentUserId: AGENT,
    });
    expect(h.updates).toBe(1);
  });
});
