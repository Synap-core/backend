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
}): Promise<{ allowed: boolean; reason: ReviewAuthorityReason }> {
  const { proposal, userId } = args;
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

  // An agent-authored proposal carries `sourceId` = the acting agent's user
  // row, never the human's — so the direct match above can never admit the
  // human who OWNS that agent. Resolve the agent's creator (`users.createdByUserId`)
  // and admit ONLY that one human as owner too — this is the sole widening;
  // it never touches the role ladder or any other user. One extra query, only
  // when the direct sourceId match already failed.
  if (!isOwner && proposal.agentUserId) {
    const [agent] = await db
      .select({ createdByUserId: users.createdByUserId })
      .from(users)
      .where(eq(users.id, proposal.agentUserId))
      .limit(1);
    isOwner = agent?.createdByUserId === userId;
    isAgentOwner = isOwner;
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

  const { allowed } = await computeCanReviewApproval({ proposal, userId });

  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Not authorized to ${action} this proposal`,
    });
  }
}
