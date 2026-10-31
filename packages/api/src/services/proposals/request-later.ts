/**
 * "Later" on a request (founder decision G3, 30 Oct 2026) — the one door that
 * sets a pending request aside for ONE person, and takes it back.
 *
 * It writes `proposal_snoozes` only: governance is untouched, the request
 * stays pending for everyone, and the needs-you rule reads the row as Review
 * later for this person alone until its time (`classifyPendingProposals`).
 * Anyone who may open the request may set it aside for themselves.
 */

import { TRPCError } from "@trpc/server";
import {
  db as defaultDb,
  and,
  eq,
  proposals,
  proposalSnoozes,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { REQUEST_LATER_MAX_MS } from "@synap-core/types/proposals";
import { assertProposalVisibleTo } from "../../utils/proposal-visibility.js";

type Database = typeof defaultDb;

/**
 * Set `proposalId` aside for `userId` until `until`. A second call moves the
 * time. Refused: a request that is not pending (nothing to put off), a time
 * not in the future, or one more than 30 days ahead.
 */
export async function setRequestLater(input: {
  proposalId: string;
  userId: string;
  until: Date;
  now?: Date;
  db?: Database;
}): Promise<{ proposalId: string; snoozedUntil: Date }> {
  const database = input.db ?? defaultDb;
  const now = input.now ?? new Date();
  const until = input.until.getTime();
  if (!Number.isFinite(until) || until <= now.getTime()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Later needs a time in the future.",
    });
  }
  if (until > now.getTime() + REQUEST_LATER_MAX_MS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Later can set a request aside for 30 days at most.",
    });
  }
  await assertProposalVisibleTo(input.proposalId, input.userId, {
    db: database,
  });
  const [row] = await database
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, input.proposalId))
    .limit(1);
  if (row?.status !== ProposalStatus.PENDING) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This request is already decided, so there is nothing to put off.",
    });
  }
  const [saved] = await database
    .insert(proposalSnoozes)
    .values({
      proposalId: input.proposalId,
      userId: input.userId,
      snoozedUntil: input.until,
    })
    .onConflictDoUpdate({
      target: [proposalSnoozes.proposalId, proposalSnoozes.userId],
      set: { snoozedUntil: input.until },
    })
    .returning({
      proposalId: proposalSnoozes.proposalId,
      snoozedUntil: proposalSnoozes.snoozedUntil,
    });
  return saved!;
}

/** Take back this person's "Later" on a request (the receipt's Undo). */
export async function clearRequestLater(input: {
  proposalId: string;
  userId: string;
  db?: Database;
}): Promise<{ cleared: boolean }> {
  const database = input.db ?? defaultDb;
  const removed = await database
    .delete(proposalSnoozes)
    .where(
      and(
        eq(proposalSnoozes.proposalId, input.proposalId),
        eq(proposalSnoozes.userId, input.userId)
      )
    )
    .returning({ proposalId: proposalSnoozes.proposalId });
  return { cleared: removed.length > 0 };
}
