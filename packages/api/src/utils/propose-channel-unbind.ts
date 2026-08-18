import { checkPermissionOrPropose } from "./permission-check.js";

/**
 * Shared core for the `channel/unbind` governance flow — the SINGLE source of
 * truth for the proposal DATA SHAPE the `channel/unbind` approve-executor
 * reads. Mirrors `proposeChannelBind` (`propose-channel-bind.ts`), INVERTED:
 * clears an already-bound channel's context pointer instead of setting it.
 *
 * `branchPurpose` is DELIBERATELY never touched here — the firewall role is
 * immutable once set (see `setChannelBranchPurpose` / the DB trigger); unbind
 * only clears WHERE the channel points, never WHAT KIND of channel it is.
 *
 * Like bind, "channel.unbind" is NOT in DEFAULT_AUTO_APPROVE for an AI/agent
 * caller (agentUserId or source "ai"/"intelligence") — an agent-sourced unbind
 * always proposes unless a workspace explicitly opts "channel.unbind" into
 * autoApproveFor. A direct human caller (no agentUserId, no AI source) is
 * governed by ordinary RBAC instead: `checkPermissionOrPropose` grants
 * immediately for an editor+ member and only proposes when the caller's
 * workspace role is insufficient (the "member proposes → owner approves" loop).
 */
export interface ProposeChannelUnbindInput {
  /** The user who should approve this if it requires review. */
  userId: string;
  workspaceId: string | null;
  /** The already-bound channel to unbind. */
  channelId: string;
  /** Present only when an AI agent is the acting caller. */
  agentUserId?: string;
  source?: string;
  /** Optional agent reasoning shown in the proposal inbox item. */
  reasoning?: string;
}

export async function proposeChannelUnbind(input: ProposeChannelUnbindInput) {
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    agentUserId: input.agentUserId,
    workspaceId: input.workspaceId,
    subjectType: "channel",
    action: "unbind",
    source: input.source,
    data: {
      // Same convention as bind: `id` IS the subject of this proposal — it is
      // what permission-check derives `proposals.targetId` from, and MUST be
      // the real channel id so the pending-proposal dedup guard (keyed on
      // targetId) can actually match a repeated unbind attempt for the same
      // channel. The approve executor reads `data.channelId`.
      id: input.channelId,
      channelId: input.channelId,
    },
    reasoning: input.reasoning,
  });

  if ("denied" in perm && perm.denied) {
    return { status: "denied" as const, reason: perm.reason };
  }

  if ("proposalId" in perm) {
    return {
      status: "proposed" as const,
      proposalId: perm.proposalId,
      summary: perm.summary,
      reasoning: perm.reasoning,
      reviewPath: perm.reviewPath,
      reviewUrl: perm.reviewUrl,
      message: "Proposal created — user must approve unbinding this channel.",
    };
  }

  // Granted — caller performs the actual clear (checkPermissionOrPropose only
  // gates permission; it does not write). Mirrors proposeChannelBind's
  // contract, whose write is likewise applied by the caller / the
  // channel/bind(unbind) approve-executor, never here.
  return {
    status: "approved" as const,
    channelId: input.channelId,
    message: "Channel unbind auto-approved.",
  };
}
