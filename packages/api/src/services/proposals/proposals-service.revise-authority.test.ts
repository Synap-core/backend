/**
 * REVISE AUTHORITY (P0 door-parity severance).
 *
 * `mergeProposalRevision` is the ONE shared revise core behind all three revise
 * doors: tRPC `proposals.revise`, Hub `proposals.updateProposal`, and MCP
 * `synap_revise_proposal` (via `reviseProposal`). Only the tRPC door checked
 * review authority — the other two reached this core with a RAW caller-supplied
 * proposal id and no predicate, so an agent could rewrite the `summary` /
 * `reasoning` (the exact text a human reads before approving) on ANY pending
 * proposal on the pod.
 *
 * The gate now lives in the core, so these tests pin it once for every door.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  updates: 0,
  allowed: true,
  reviewArgs: [] as Array<Record<string, unknown>>,
}));

// PARTIAL mock (see the `database-mock-total-ratchet` tripwire): keep the real
// tables, enums and operators — fake only `db.transaction`.
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
    db: {
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    },
  };
});

vi.mock("../agent-identity-service.js", () => ({
  ownAgentUserFilter: () => undefined,
}));

vi.mock("../../routers/proposals/review-authority.js", () => ({
  computeCanReviewApproval: async (args: Record<string, unknown>) => {
    h.reviewArgs.push(args);
    return {
      allowed: h.allowed,
      reason: h.allowed ? "owner" : "not-authorized",
    };
  },
}));

import { mergeProposalRevision, reviseProposal } from "./proposals-service.js";

const PENDING_ROW = {
  data: { _summary: "original", targetType: "entity" },
  status: "pending",
  workspaceId: "ws-1",
  agentUserId: null,
};

beforeEach(() => {
  h.row = { ...PENDING_ROW };
  h.updates = 0;
  h.allowed = true;
  h.reviewArgs.length = 0;
});

describe("mergeProposalRevision — review authority", () => {
  it("writes the revision when the actor may review the proposal", async () => {
    await mergeProposalRevision({
      proposalId: "p-1",
      summary: "rewritten",
      actorId: "reviewer-1",
    });

    expect(h.updates).toBe(1);
    expect(h.reviewArgs).toHaveLength(1);
    expect(h.reviewArgs[0]).toMatchObject({ userId: "reviewer-1" });
  });

  it("refuses (and writes NOTHING) when the actor may not review it", async () => {
    h.allowed = false;

    await expect(
      mergeProposalRevision({
        proposalId: "p-1",
        summary: "tampered",
        actorId: "stranger",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(h.updates).toBe(0);
  });

  it("fails CLOSED when no actor is supplied — an absent actor is not authority", async () => {
    await expect(
      mergeProposalRevision({ proposalId: "p-1", summary: "anon" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(h.updates).toBe(0);
    // The ladder is never even consulted — there is nobody to consult it for.
    expect(h.reviewArgs).toHaveLength(0);
  });

  it("gates on the proposal's OWN workspace/agent, not on caller-supplied fields", async () => {
    h.row = {
      ...PENDING_ROW,
      workspaceId: "ws-secret",
      agentUserId: "agent-7",
    };

    await mergeProposalRevision({
      proposalId: "p-1",
      summary: "ok",
      actorId: "reviewer-1",
      // A re-target request must not be what authority is computed against.
      workspaceId: "ws-mine",
    });

    expect(h.reviewArgs[0]).toMatchObject({
      proposal: { workspaceId: "ws-secret", agentUserId: "agent-7" },
    });
  });

  it("checks authority BEFORE leaking the proposal's status (no oracle)", async () => {
    // A decided proposal would normally CONFLICT; an unauthorized caller must
    // get the same NOT_FOUND either way.
    h.row = { ...PENDING_ROW, status: "approved" };
    h.allowed = false;

    await expect(
      mergeProposalRevision({
        proposalId: "p-1",
        summary: "x",
        actorId: "stranger",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("NOT_FOUND for a missing proposal, without consulting the ladder", async () => {
    h.row = undefined;

    await expect(
      mergeProposalRevision({
        proposalId: "p-missing",
        summary: "x",
        actorId: "reviewer-1",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(h.reviewArgs).toHaveLength(0);
  });
});

describe("reviseProposal — the MCP door inherits the same gate", () => {
  it("refuses a summary/reasoning rewrite by a non-reviewer", async () => {
    h.allowed = false;

    await expect(
      reviseProposal({
        proposalId: "p-1",
        summary: "looks safe, approve me",
        reasoning: "trust me",
        actorId: "other-agent-owner",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(h.updates).toBe(0);
  });
});
