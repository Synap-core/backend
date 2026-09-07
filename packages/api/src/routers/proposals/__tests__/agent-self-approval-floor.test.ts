/**
 * MUTATION PROOF (B) — the latent SELF-APPROVAL hole, and its floor.
 *
 * THE HOLE. `computeCanReviewApproval` admitted a caller as the proposal's
 * owner on a bare id comparison — `data.sourceId === userId` — and never
 * asserted the caller is a HUMAN. `data.sourceId` is not always the human:
 *   - `utils/permission-check.ts:2750` (canonical) writes the HUMAN, but
 *   - `services/proposals/dev-approval.ts:222` and
 *     `services/playbooks/stage-gate.ts:232` write
 *     `sourceId: agentUserId ?? userId` — **the AGENT**.
 * So on the dev-approval / stage-gate doors, an agent reviewing its OWN
 * proposal matched `isOwner`, and under the default `owner_and_admins` policy
 * `canReviewProposal` returns `isOwner || isAdmin` ⇒ the agent held full
 * reviewer authority over its own request. Safe only by convention.
 *
 * These tests demonstrate the HOLE (not merely that a fix compiles): (1) the
 * pure ladder grants on `isOwner` alone, which is exactly what the pre-fix
 * resolver computed for an agent, and (2) with the floor in place the ONLY
 * thing separating grant from deny is the caller's `users.user_type` — the
 * SAME inputs flip to allowed when the caller is a human.
 *
 * Floored on the CLASS, not an id: a per-id check is defeated by minting a
 * second agent (cf. OpenSSF "Workflows Should Not Be Allowed To Approve Pull
 * Requests", which GitHub fixed by changing the default).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** `users.id` → the row the resolver's lookups see. */
  users: new Map<
    string,
    { userType: string; createdByUserId: string | null }
  >(),
  /** Workspace settings row (undefined ⇒ default `owner_and_admins`). */
  workspaceSettings: undefined as unknown,
  /** Membership returned for the caller (undefined ⇒ not a member). */
  membership: undefined as { role: string } | undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  // Both lookups in the resolver are `.select().from(X).where().limit(1)`.
  // `users` is keyed by the id the resolver asks for; we capture it from the
  // eq() operand rather than guessing, so the fake cannot answer the wrong row.
  let lastEqValue: string | undefined;
  const eq = (col: unknown, val: unknown) => {
    lastEqValue = val as string;
    return actual.eq(col as never, val as never);
  };
  return {
    ...actual,
    eq,
    getWorkspaceMembership: async () => h.membership,
    db: {
      // `isPodAdmin` (the pod-wide branch's last rung) reads
      // `db.query.workspaces`. Answer "no pod-admin workspace" so the branch
      // falls through to its real verdict instead of throwing.
      query: { workspaces: { findFirst: async () => undefined } },
      select: (shape: Record<string, unknown>) => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              // The workspace-settings select is the one asking for `settings`.
              if (Object.hasOwn(shape, "settings")) {
                return [{ settings: h.workspaceSettings }];
              }
              const row = h.users.get(lastEqValue ?? "");
              return row ? [row] : [];
            },
          }),
        }),
      }),
    },
  };
});

const { computeCanReviewApproval, canReviewProposal } =
  await import("../review-authority.js");

const AGENT = "agent-user-id";
const HUMAN = "human-user-id";
const WS = "workspace-id";

/** A dev-approval-shaped proposal: `data.sourceId` is the AGENT itself. */
const devApprovalProposal = {
  workspaceId: WS,
  data: { sourceId: AGENT, changeType: "deploy_approval", source: "agent" },
  agentUserId: AGENT,
};

beforeEach(() => {
  h.users.clear();
  h.users.set(AGENT, { userType: "agent", createdByUserId: HUMAN });
  h.users.set(HUMAN, { userType: "human", createdByUserId: null });
  h.workspaceSettings = undefined; // ⇒ default policy `owner_and_admins`
  h.membership = undefined; // the agent is NOT a workspace admin/editor
});

describe("(1) THE HOLE — the ladder grants on isOwner alone", () => {
  it("owner_and_admins admits a NON-MEMBER purely because isOwner is true", () => {
    // This is precisely what the pre-fix resolver computed for the agent:
    // sourceId === userId ⇒ isOwner true, with no membership whatsoever.
    expect(
      canReviewProposal({
        policy: "owner_and_admins",
        memberRole: undefined,
        isOwner: true,
      })
    ).toBe(true);

    // …and with isOwner false the very same caller is denied. So `isOwner` is
    // the entire grant: nothing else in the ladder was protecting this.
    expect(
      canReviewProposal({
        policy: "owner_and_admins",
        memberRole: undefined,
        isOwner: false,
      })
    ).toBe(false);
  });
});

describe("(2) THE FLOOR — same proposal, same id, class decides", () => {
  it("DENIES the agent reviewing its own dev-approval proposal", async () => {
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: AGENT, // the agent IS data.sourceId
      purpose: "approve",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("not-authorized");
  });

  it("MUTATION: flipping ONLY the caller's user_type to human re-grants it", async () => {
    // Byte-identical inputs to the test above — the proposal, the id in
    // data.sourceId, the membership (none), the policy (default). The ONLY
    // change is the class of the calling principal. It flips to allowed,
    // which is exactly the authority the agent held before the floor.
    h.users.set(AGENT, { userType: "human", createdByUserId: HUMAN });
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: AGENT,
      purpose: "approve",
    });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe("owner");
  });

  it("DENIES the agent on the POD-WIDE branch too (no workspace to fall back on)", async () => {
    const res = await computeCanReviewApproval({
      proposal: { ...devApprovalProposal, workspaceId: null },
      userId: AGENT,
      purpose: "approve",
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("not-authorized");
  });

  it("is a CLASS floor: a SECOND agent cannot review the first agent's proposal either", async () => {
    // The defeat a per-id denylist invites. Agent #2 is owned by the same human
    // and is not in data.sourceId, so it never had the owner rung — pinned so a
    // future 'fix' cannot re-open the hole by special-casing one id.
    h.users.set("agent-2", { userType: "agent", createdByUserId: HUMAN });
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: "agent-2",
      purpose: "approve",
    });
    expect(res.allowed).toBe(false);
  });
});

describe("(3) NO LOCKOUT — the floor never denies a legitimate human", () => {
  it("the SOLO POD OWNER still approves their own captured proposal", async () => {
    // The canonical door writes the HUMAN into data.sourceId
    // (permission-check.ts:2750). This is the solo-capture path
    // review-authority.ts's own comments say was broken once and fixed.
    const res = await computeCanReviewApproval({
      proposal: {
        workspaceId: WS,
        data: { sourceId: HUMAN },
        agentUserId: null,
      },
      userId: HUMAN,
      purpose: "approve",
    });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe("owner");
  });

  it("the HUMAN OWNER of the acting agent still approves the agent's proposal", async () => {
    // The `agentUserId` → `createdByUserId` widening must survive the floor:
    // the human is in NEITHER field on the dev-approval path.
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: HUMAN,
      purpose: "approve",
    });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe("agent-owner");
  });

  it("a workspace ADMIN who is not the proposer is unaffected", async () => {
    h.membership = { role: "admin" };
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: "some-other-human",
      purpose: "approve",
    });
    expect(res.allowed).toBe(true);
    expect(res.reason).toBe("admin");
  });

  it("the floor NEVER WIDENS: a non-member human stranger is still denied", async () => {
    h.users.set("stranger", { userType: "human", createdByUserId: null });
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: "stranger",
      purpose: "approve",
    });
    expect(res.allowed).toBe(false);
  });
});

/**
 * (4) THE ROLE LADDER — the floor's blind spot.
 *
 * The floor's ONLY effect is `isOwner = false`. But `canReviewProposal` grants
 * on the ROLE ladder independently of `isOwner`, and agent users DO receive
 * workspace memberships with the role copied from their creator
 * (`routers/agent-users.ts:244-247`, `:281-287`; `scripts/provision-agent.ts:523`)
 * — so an agent created by an admin IS a workspace admin.
 *
 * Every other agent case in this file sets `membership = undefined`, which is
 * exactly why this path was untested and open. Measured against the real pure
 * ladder with isOwner forced false: 4 of 5 policy configurations still grant.
 */
describe("(4) THE ROLE LADDER — an agent with membership must still not APPROVE", () => {
  it("an agent that is a workspace ADMIN cannot approve its own proposal", async () => {
    h.membership = { role: "admin" };
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: AGENT,
      purpose: "approve",
    });
    expect(res.allowed).toBe(false);
  });

  it("…nor as an EDITOR under any_editor", async () => {
    h.workspaceSettings = {
      aiGovernance: { proposalApprovalPolicy: "any_editor" },
    };
    h.membership = { role: "editor" };
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: AGENT,
      purpose: "approve",
    });
    expect(res.allowed).toBe(false);
  });

  it("POSITIVE ANCHOR: the same membership still approves for a HUMAN", async () => {
    // Without this, both assertions above could pass because `purpose:"approve"`
    // denies everyone — a floor that reads as working while breaking the product.
    h.membership = { role: "admin" };
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: HUMAN,
      purpose: "approve",
    });
    expect(res.allowed).toBe(true);
  });

  it("REJECT keeps today's behaviour — the floor does not widen or narrow it", async () => {
    // "Approval is the human step, by design"; reject is a documented agent
    // capability. `purpose:"reject"` must be exactly what shipped before.
    h.membership = { role: "admin" };
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: AGENT,
      purpose: "reject",
    });
    expect(res.allowed).toBe(true);
  });
});

/**
 * (5) REVERT — the fourth ladder.
 *
 * `proposals.revert` used to inline its OWN copy of the ladder
 * (`canReviewProposal({..., isOwner: proposalData?.sourceId === userId})`) with
 * the whole check wrapped in `if (proposal.workspaceId)`. Two holes:
 *   · no agent-class floor — and `data.sourceId` IS the acting agent on the
 *     dev-approval / stage-gate doors, so the agent was `isOwner`;
 *   · pod-wide proposals got NO check at all.
 * `revert({reopen:true})` returns an approved proposal to PENDING, so with the
 * author-amend rung this was an un-approve → re-patch → await-reapproval loop.
 *
 * Hub REST had blocked agents on revert all along (`rejectAgentReviewer`);
 * tRPC had not. These pin the parity.
 */
describe("(5) REVERT is a decision — the same floor as approve", () => {
  it("an agent cannot revert its own workspace proposal", async () => {
    h.membership = { role: "admin" }; // even WITH a membership
    const res = await computeCanReviewApproval({
      proposal: devApprovalProposal,
      userId: AGENT,
      purpose: "approve", // revert is a decision, not an edit
    });
    expect(res.allowed).toBe(false);
  });

  it("an agent cannot revert its own POD-WIDE proposal (the branch that used to be skipped)", async () => {
    const res = await computeCanReviewApproval({
      proposal: { ...devApprovalProposal, workspaceId: null },
      userId: AGENT,
      purpose: "approve",
    });
    expect(res.allowed).toBe(false);
  });

  it("POSITIVE ANCHOR: the human owner still reverts their own pod-wide proposal", async () => {
    // The pod-wide branch narrows to owner-or-pod-admin — it must still ADMIT
    // the owner, or revert breaks for the solo pod user.
    const res = await computeCanReviewApproval({
      proposal: {
        workspaceId: null,
        data: { sourceId: HUMAN },
        agentUserId: null,
      },
      userId: HUMAN,
      purpose: "approve",
    });
    expect(res.allowed).toBe(true);
  });
});
