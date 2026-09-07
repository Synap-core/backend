/**
 * Proposal review-authority ladder — "may this user approve/reject/reopen/
 * revert this proposal?" — extracted verbatim from proposals.ts (Wave 5
 * router-decomposition). Every export here is used by `proposalsRouter`
 * (approve/batchApprove/reject/reopen/batchReject/revert/list/revise) and by
 * nothing else — a pure, DB-touching authority layer with no router coupling.
 */

import { TRPCError } from "@trpc/server";
import { db, eq, getWorkspaceMembership, users } from "@synap/database";
import { workspaces } from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import { isPodAdmin } from "../../utils/workspace-role.js";

export type ProposalApprovalPolicy =
  "admins_only" | "any_editor" | "owner_and_admins";

/**
 * Single source of truth for "may this member review (approve / reject / revert)
 * this workspace-scoped proposal?" — the SAME ladder that `approve`,
 * `batchApprove`, `revert`, and the list's `viewerCanReview` flag all read, so
 * the button shows iff the mutation would succeed. Pod-wide proposals (no
 * workspace) skip this entirely and are decided by the caller.
 */
export function canReviewProposal(args: {
  policy: ProposalApprovalPolicy;
  memberRole: string | undefined;
  isOwner: boolean;
}): boolean {
  // Workspace `owner` is the TOP role — it satisfies every policy (owner ≥ admin
  // ≥ editor). The previous ladder matched only `=== "admin"`, so an actual
  // workspace OWNER was locked out of approving agent proposals under the default
  // `owner_and_admins` policy: `isOwner` here means "approver IS the proposer"
  // (sourceId === userId), NOT "workspace owner" — and agent proposals carry
  // sourceId = the agent, so that flag never helps the human owner. Net effect was
  // the 403 "Not authorized to approve this proposal" for the workspace owner.
  const isAdmin = args.memberRole === "admin" || args.memberRole === "owner";
  const isEditor = args.memberRole === "editor" || isAdmin;
  return args.policy === "admins_only"
    ? isAdmin
    : args.policy === "any_editor"
      ? isEditor
      : /* owner_and_admins */ args.isOwner || isAdmin;
}

/**
 * A short, DISPLAY-ONLY code (+ the enum it's drawn from) explaining WHY
 * `canReviewProposal`'s verdict came out the way it did. Never a decision
 * input — purely narrates the SAME boolean the ladder already computed, so
 * the UI can render "You can approve because…" instead of a bare checkmark.
 */
export type ReviewAuthorityReason =
  "pod-wide" | "owner" | "agent-owner" | "admin" | "editor" | "not-authorized";

/**
 * Format the reviewer-authority reason from the EXACT inputs `canReviewProposal`
 * gates on, plus its own verdict — so the explanation can never disagree with
 * the decision. `isAgentOwner` distinguishes "you proposed this yourself"
 * (owner) from "you own the agent that proposed this" (agent-owner); callers
 * that don't resolve agent ownership (e.g. the batched `list` computation)
 * simply omit it and get "owner" for both.
 */
export function formatReviewAuthorityReason(args: {
  hasWorkspace: boolean;
  policy: ProposalApprovalPolicy;
  memberRole: string | undefined;
  isOwner: boolean;
  isAgentOwner?: boolean;
  allowed: boolean;
}): ReviewAuthorityReason {
  if (!args.hasWorkspace) return "pod-wide";
  if (!args.allowed) return "not-authorized";
  if (args.isAgentOwner) return "agent-owner";
  if (args.isOwner) return "owner";
  const isAdmin = args.memberRole === "admin" || args.memberRole === "owner";
  if (isAdmin) return "admin";
  return "editor";
}

/**
 * Human-readable suffix for a "not-authorized" verdict (which authority WOULD
 * satisfy this workspace's policy) — the "requires admin" half of the spec'd
 * `"not-authorized: requires admin"` display string.
 */
export function reviewAuthorityRequirement(
  policy: ProposalApprovalPolicy
): string {
  return policy === "any_editor" ? "editor" : "admin";
}

/**
 * AGENT-CLASS FLOOR (B). Is this principal an AGENT user row rather than a human?
 *
 * The two owner rungs below admit a caller as "the proposer" — and under the
 * default `owner_and_admins` policy the proposer alone satisfies the policy.
 * Neither rung ever checked that the caller is a HUMAN, so an agent whose own
 * user id sits in `data.sourceId` (which is exactly what
 * `services/proposals/dev-approval.ts:222` and `services/playbooks/stage-gate.ts:232`
 * write: `sourceId: input.agentUserId ?? input.userId`) would be admitted as
 * reviewer of ITS OWN proposal. That is self-approval, and it defeats the whole
 * point of a proposal.
 *
 * Floor it on the CLASS, not on a specific id: a per-id denylist is defeated by
 * minting a second agent. This mirrors the industry precedent — OpenSSF's
 * "Workflows Should Not Be Allowed To Approve Pull Requests", which GitHub
 * resolved by changing the DEFAULT rather than trusting convention.
 *
 * `users.userType === 'agent'` is the canonical is-agent signal in this codebase
 * (see `access/key-identity.ts:7`); reused here rather than re-derived.
 */
async function isAgentPrincipal(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userType: users.userType })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.userType === "agent";
}

/**
 * "May this user APPROVE this proposal?" — the shared, byte-identical
 * authorization COMPUTATION that `approve` and `batchApprove` used to inline
 * verbatim (settings → policy → membership → `canReviewProposal`). Returns
 * `{ allowed, reason }`: `allowed` is the SAME boolean as before (each caller
 * keeps its OWN failure behavior — `approve` throws FORBIDDEN, `batchApprove`
 * records `{success:false}` and continues the batch — so this changes NO
 * observable denial behavior); `reason` is purely additive, narrating WHY, for
 * a caller that wants to surface it (e.g. an error message or the AuthorityRow
 * once threaded through `proposals.list`). Pod-wide proposals (no workspaceId)
 * are decided by the caller, so this returns `{allowed:true, reason:"pod-wide"}`
 * (mirrors the inline `if (proposal.workspaceId)` guard skipping the check
 * entirely). NOT the same as `assertCanReviewProposal` below, which serves the
 * reject/reopen path and throws with a different verb.
 */
export async function computeCanReviewApproval(args: {
  proposal: {
    workspaceId: string | null;
    data: unknown;
    agentUserId?: string | null;
  };
  userId: string;
  /**
   * WHICH authority is being asked for. **Required — deliberately no default.**
   *
   * The owner-rung floor below only ever sets `isOwner = false`, but
   * `canReviewProposal` grants on the ROLE ladder independently: measured
   * against the real ladder with `isOwner` forced false, 4 of 5 policy
   * configurations still grant (`owner_and_admins`+admin, +owner;
   * `any_editor`+editor; `admins_only`+admin). Agent users DO hold workspace
   * memberships — `routers/agent-users.ts:244-247,281-287` copies the role from
   * their creator, so an agent created by an admin IS a workspace admin. The
   * owner floor alone therefore did NOT floor the class, despite saying so.
   *
   *  · `"approve"` — an agent principal is refused BEFORE the policy ladder.
   *    "Approval is the human step, by design" (CLAUDE.md); the agent key can
   *    reject but never approve.
   *  · `"reject"` — EXACTLY today's behaviour (owner rungs floored, role ladder
   *    untouched). Strictly monotone: approve's grants ⊆ reject's grants.
   *
   * Required rather than defaulted so a NEW call site is a compile error rather
   * than a silent grant. A default would make this a convention; the absence of
   * one makes it a floor.
   */
  purpose: "approve" | "reject";
}): Promise<{ allowed: boolean; reason: ReviewAuthorityReason }> {
  const { proposal, userId, purpose } = args;

  // CLASS FLOOR — before any ladder, and only for `approve`. This is the rung
  // the owner-only floor below could not reach: it denies an agent principal
  // even when it holds an admin/editor membership of its own.
  if (purpose === "approve" && (await isAgentPrincipal(userId))) {
    return { allowed: false, reason: "not-authorized" };
  }
  if (!proposal.workspaceId) {
    // Pod-wide proposals have no workspace membership ladder to fall back on,
    // so "any pod member" used to be treated as authorized — a stranger could
    // rubber-stamp another user's pod-wide proposal. Narrow this to the
    // proposal's own owner (creator, or the human who owns the acting agent)
    // OR a pod-admin — the SAME two authorities `revise`'s pod-wide downgrade
    // path already trusts (see `isPodAdmin` above). Solo-capture UX (approving
    // your own pod-wide proposals) is preserved.
    const proposalData = proposal.data as Record<string, unknown> | null;
    let isOwner = proposalData?.sourceId === userId;
    let isAgentOwner = false;

    if (!isOwner && proposal.agentUserId) {
      const [agent] = await db
        .select({ createdByUserId: users.createdByUserId })
        .from(users)
        .where(eq(users.id, proposal.agentUserId))
        .limit(1);
      isOwner = agent?.createdByUserId === userId;
      isAgentOwner = isOwner;
    }

    // AGENT-CLASS FLOOR (B): only ever NARROWS. `isOwner` is true here because
    // the caller matched `data.sourceId` or owns the acting agent — but neither
    // rung asserted the caller is a human. One query, and only on the path where
    // an owner rung actually fired, so the common reviewer path is unchanged.
    if (isOwner && (await isAgentPrincipal(userId))) {
      isOwner = false;
      isAgentOwner = false;
    }

    if (isOwner) {
      return { allowed: true, reason: isAgentOwner ? "agent-owner" : "owner" };
    }

    if (await isPodAdmin(userId)) {
      return { allowed: true, reason: "admin" };
    }

    return { allowed: false, reason: "not-authorized" };
  }

  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, proposal.workspaceId))
    .limit(1);

  const settings = ws?.settings as WorkspaceSettings | undefined;
  const policy =
    settings?.aiGovernance?.proposalApprovalPolicy ?? "owner_and_admins";

  const membership = await getWorkspaceMembership(
    db,
    proposal.workspaceId,
    userId
  );
  const proposalData = proposal.data as Record<string, unknown> | null;
  let isOwner = proposalData?.sourceId === userId;
  let isAgentOwner = false;

  // CORRECTED 2026-09-07 — this comment previously asserted "an agent-authored
  // proposal carries `sourceId` = the acting agent's user row, never the
  // human's." THAT IS FALSE, and it sat directly above an authority gate.
  // `data.sourceId` holds a DIFFERENT principal depending on which door wrote
  // the proposal (see the `data.sourceId` contract on `RequestShapedProposalData`
  // in `@synap/database` schema/proposals.ts):
  //   - `utils/permission-check.ts:2750` (canonical `createProposal`, the path
  //     almost every agent write takes) writes `sourceId: userId` = the HUMAN.
  //   - `services/proposals/dev-approval.ts:222` and
  //     `services/playbooks/stage-gate.ts:232` write
  //     `sourceId: agentUserId ?? userId` = the AGENT when one is acting.
  // So the direct match above admits the human on the canonical path, and would
  // admit the AGENT ITSELF on the dev-approval/stage-gate paths — which is why
  // the agent-class floor below exists. The `agentUserId` resolution here is
  // still needed: on the dev-approval paths the human is in NEITHER field, so
  // resolve the agent's creator (`users.createdByUserId`) and admit ONLY that
  // one human as owner too. One extra query, only when the direct match failed.
  if (!isOwner && proposal.agentUserId) {
    const [agent] = await db
      .select({ createdByUserId: users.createdByUserId })
      .from(users)
      .where(eq(users.id, proposal.agentUserId))
      .limit(1);
    isOwner = agent?.createdByUserId === userId;
    isAgentOwner = isOwner;
  }

  // AGENT-CLASS FLOOR (B): only ever NARROWS. `isOwner` is true here because
  // the caller matched `data.sourceId` or owns the acting agent — but neither
  // rung asserted the caller is a human. One query, and only on the path where
  // an owner rung actually fired, so the common reviewer path is unchanged.
  if (isOwner && (await isAgentPrincipal(userId))) {
    isOwner = false;
    isAgentOwner = false;
  }

  const resolvedPolicy = policy as ProposalApprovalPolicy;
  const allowed = canReviewProposal({
    policy: resolvedPolicy,
    memberRole: membership?.role,
    isOwner,
  });
  const reason = formatReviewAuthorityReason({
    hasWorkspace: true,
    policy: resolvedPolicy,
    memberRole: membership?.role,
    isOwner,
    isAgentOwner,
    allowed,
  });
  return { allowed, reason };
}

/**
 * Authorize a `revise` re-target of `proposals.workspaceId` onto a NEW
 * destination — closes the gap where `revise` only checked authority against
 * the proposal's CURRENT workspace, so a workspace-W reviewer could move a
 * proposal into a workspace they cannot access (queue injection), or clear
 * `workspaceId` to `null` to widen it to pod-wide (a data-scope escalation).
 *
 * - destination = a real workspace → require the SAME reviewer-authority
 *   ladder `computeCanReviewApproval` already enforces on the source side,
 *   evaluated against the DESTINATION workspace's own policy/membership (a
 *   plain member of the destination is not enough if its policy requires
 *   admin, exactly as if the proposal had originated there).
 * - destination = `null` (pod-wide downgrade) → require pod-admin
 *   (`isPodAdmin`) — a workspace reviewer must never be able to widen a
 *   proposal's visibility to the whole pod.
 */
export async function assertCanRetargetProposalDestination(args: {
  proposal: { data: unknown; agentUserId?: string | null };
  destWorkspaceId: string | null;
  userId: string;
}): Promise<void> {
  const { proposal, destWorkspaceId, userId } = args;

  if (destWorkspaceId === null) {
    if (!(await isPodAdmin(userId))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Only pod administrators can widen a proposal to pod-wide (clear its workspace).",
      });
    }
    return;
  }

  const { allowed: canReviewDest } = await computeCanReviewApproval({
    // Re-target is reached from `revise`, so it keeps revise's bar (today's
    // behaviour). ⚠️ FOLLOW-UP, deliberately NOT bundled: a re-target is a
    // scope-escalation primitive, so an agent principal arguably should be
    // refused here too. That is a NARROWING with its own evidence to gather;
    // this wave does not change it in either direction.
    purpose: "reject" as const,
    proposal: {
      workspaceId: destWorkspaceId,
      data: proposal.data,
      agentUserId: proposal.agentUserId,
    },
    userId,
  });
  if (!canReviewDest) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Not authorized to move this proposal into the destination workspace",
    });
  }
}

/**
 * Authority gate shared by `reject` / `reopen` / `batchReject` — now literally
 * `computeCanReviewApproval`'s verdict, thrown instead of returned. Throws
 * FORBIDDEN when the caller may not review this proposal. `action` only shapes
 * the error-message verb; the ladder, the DB reads, and the pod-wide predicate
 * are the approve path's, byte-for-byte, because they ARE the approve path's.
 *
 * SECURITY (1): without this gate at all, reject/reopen/batchReject only
 * enforced `requireUserId` — any authenticated member could reject/reopen ANY
 * proposal by id.
 *
 * SECURITY (2): this function USED to short-circuit `if (!proposal.workspaceId)
 * return;` — an unconditional ALLOW for every pod-wide proposal — while
 * claiming in this very comment to "mirror approve". Approve had since been
 * hardened (`computeCanReviewApproval`: owner / agent-owner / pod-admin), so
 * the mirror was a lie and ANY authenticated pod user could reject or REOPEN
 * any pod-wide proposal (`cell/define`, `capability.install`, …). Delegating to
 * the one predicate makes the drift structurally impossible to re-open.
 *
 * WHY reject AND reopen share ONE bar (they are not obviously symmetric):
 * `reopen` is the RESURRECTION primitive — it puts a REJECTED proposal back
 * into the pending queue, where a single further approval materializes the
 * write. So reopen's power is bounded above by approve's: anyone who may
 * approve a pod-wide proposal may already cause exactly the effect that
 * reopening enables, and nobody else gains anything by reopening. Requiring
 * *more* than approve authority for reopen would therefore lock the proposal's
 * own owner out of retrying their own agent's rejected write while leaving them
 * able to approve it — incoherent. Requiring LESS is the bug this fixes. Reject
 * is the strictly-safer direction (it only ever declines a write), but it is
 * still a queue mutation on someone else's proposal, and giving it the same
 * owner/pod-admin bar costs a legitimate reviewer nothing: rejecting YOUR OWN
 * agent's proposal — the common case — is admitted by the agent-owner rung.
 */
export async function assertCanReviewProposal(args: {
  proposal: {
    workspaceId: string | null;
    data: unknown;
    agentUserId?: string | null;
  };
  userId: string;
  action: "reject" | "reopen";
}): Promise<void> {
  const { proposal, userId, action } = args;

  // reject / reopen — the documented agent capability ("can reject but never
  // approve"). EXACTLY today's behaviour; the class floor applies to approve only.
  const { allowed } = await computeCanReviewApproval({
    proposal,
    userId,
    purpose: "reject",
  });

  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Not authorized to ${action} this proposal`,
    });
  }
}
