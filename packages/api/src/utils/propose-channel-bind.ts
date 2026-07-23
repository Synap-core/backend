import { checkPermissionOrPropose } from "./permission-check.js";

/**
 * Shared core for the `channel/bind` governance flow — the SINGLE source of truth
 * for the proposal DATA SHAPE the `channel/bind` approve-executor reads. Called by
 * BOTH transports: the tRPC `bindChannel` procedure and the REST
 * `POST /api/hub/channels/:channelId/bind` route (the door the IS agent uses).
 * Keep the `data` object below in sync with the executor in
 * routers/proposals/approve-executors.ts (key "channel/bind").
 *
 * Binds an ALREADY-EXISTING channel to a context object (usually a client entity)
 * and optionally stamps the firewall role (branchPurpose). ALWAYS proposes unless a
 * workspace explicitly opted "channel.bind" into autoApproveFor — "channel.bind" is
 * deliberately NOT in DEFAULT_AUTO_APPROVE. branchPurpose is carried as explicit data
 * a human confirms; NEVER default-forced (client-comms is immutable once set).
 */
export interface ProposeChannelBindInput {
  /** The human user who should approve this (agent acts on behalf of). */
  userId: string;
  workspaceId: string;
  /** The already-existing channel to bind. */
  channelId: string;
  /** A channel binds to an entity/document/view (default: entity). */
  contextObjectType: "entity" | "document" | "view";
  /** The object (usually a client entity) to point the channel at. */
  contextObjectId: string;
  /** Optional firewall role label ("client-comms" | "team"). Never default-forced. */
  branchPurpose?: string;
  /** Optional provenance: platform-native channel id (for the review card). */
  externalChannelId?: string;
  /** Optional agent reasoning shown in the proposal inbox item. */
  reasoning?: string;
}

export async function proposeChannelBind(input: ProposeChannelBindInput) {
  const perm = await checkPermissionOrPropose({
    userId: input.userId,
    workspaceId: input.workspaceId,
    subjectType: "channel",
    action: "bind",
    source: "intelligence",
    data: {
      // `id` IS the subject of this proposal — the channel being bound. It is what
      // permission-check derives `proposals.targetId` from (`data.documentId ||
      // data.entityId || data.id || randomUUID()`), so it MUST be the real channel
      // id: a fresh randomUUID per call made the row un-addressable by its subject
      // AND made the pending-proposal dedup guard (which narrows on targetId and
      // hashes the payload) structurally unable to ever match — every repeated
      // sweep filed another pending bind for the same channel. The approve
      // executor reads `data.channelId`, never `data.id`, so execution is
      // unaffected. Two DIFFERENT binds for the same channel still coexist: the
      // dedup is exact-match on the normalized payload, so a different
      // contextObjectId/branchPurpose hashes differently.
      id: input.channelId,
      channelId: input.channelId,
      contextObjectType: input.contextObjectType,
      contextObjectId: input.contextObjectId,
      ...(input.branchPurpose !== undefined
        ? { branchPurpose: input.branchPurpose }
        : {}),
      ...(input.externalChannelId !== undefined
        ? { externalChannelId: input.externalChannelId }
        : {}),
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
      message: `Proposal created — user must approve binding this channel to ${input.contextObjectType} ${input.contextObjectId}.`,
    };
  }

  // Auto-approved (only if a workspace explicitly opted "channel.bind" into
  // autoApproveFor). The bind itself is applied by the channel/bind executor.
  return {
    status: "approved" as const,
    channelId: input.channelId,
    message: "Channel bind auto-approved.",
  };
}
