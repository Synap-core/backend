/**
 * The reads the person's own send door needs (Hub `POST /channels/:id/send`,
 * routers/hub-protocol/rest/channel-conversations.ts): the draft it sends,
 * and what the send ended as; and the draft its save door
 * (`PUT /channels/:id/drafts/:draftId`) and versions read
 * (`GET …/versions`) answer from.
 */

import { db, and, eq, inArray } from "@synap/database";
import { proposals } from "@synap/database/schema";
import { proposalUserFloor } from "../../routers/proposals/scope-conditions.js";
import { readHeld } from "./held-sends.js";
import { PROPOSED_MESSAGE_TYPE } from "./person-channels.js";

/**
 * A send the caller can read, filed on THIS channel and still open (pending,
 * held, or failed and retried), or null.
 */
export async function findOpenDraftOnChannel(args: {
  userId: string;
  draftId: string;
  channelId: string;
}): Promise<{
  id: string;
  data: unknown;
  revisionHistory: unknown;
} | null> {
  const [draft] = await db
    .select({
      id: proposals.id,
      data: proposals.data,
      revisionHistory: proposals.revisionHistory,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.id, args.draftId),
        eq(proposals.proposalType, PROPOSED_MESSAGE_TYPE),
        eq(proposals.targetId, args.channelId),
        inArray(proposals.status, ["pending", "approval_failed"]),
        proposalUserFloor(args.userId)
      )
    )
    .limit(1);
  return draft ?? null;
}

/**
 * A send the caller can read, filed on THIS channel, in ANY status (a sent,
 * rejected or withdrawn draft keeps its history readable), or null. The read
 * behind a draft's save answer and its versions; the save itself goes through
 * `findOpenDraftOnChannel` (only an open draft is reworded).
 */
export async function findDraftOnChannel(args: {
  userId: string;
  draftId: string;
  channelId: string;
}): Promise<{
  id: string;
  status: string;
  data: unknown;
  revisionHistory: unknown;
  agentUserId: string | null;
  proposedByUserId: string | null;
  createdBy: string | null;
  createdAt: Date;
} | null> {
  const [draft] = await db
    .select({
      id: proposals.id,
      status: proposals.status,
      data: proposals.data,
      revisionHistory: proposals.revisionHistory,
      agentUserId: proposals.agentUserId,
      proposedByUserId: proposals.proposedByUserId,
      createdBy: proposals.createdBy,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.id, args.draftId),
        eq(proposals.proposalType, PROPOSED_MESSAGE_TYPE),
        eq(proposals.targetId, args.channelId),
        proposalUserFloor(args.userId)
      )
    )
    .limit(1);
  return draft ?? null;
}

/**
 * What a send ended as, read from its proposal after the approval: sent
 * (approved), held (pending with `held`: not reachable yet), failed (its
 * approval failed, with the reason), or null (still pending for another
 * reason, or gone).
 */
export async function readSendOutcome(proposalId: string): Promise<{
  status: "sent" | "held" | "failed" | null;
  reason?: string;
}> {
  const [row] = await db
    .select({
      status: proposals.status,
      data: proposals.data,
      rejectionReason: proposals.rejectionReason,
    })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (!row) return { status: null };
  if (row.status === "approved") return { status: "sent" };
  if (row.status === "approval_failed") {
    return { status: "failed", reason: row.rejectionReason ?? undefined };
  }
  const held = row.status === "pending" ? readHeld(row.data) : null;
  return held ? { status: "held", reason: held.reason } : { status: null };
}
