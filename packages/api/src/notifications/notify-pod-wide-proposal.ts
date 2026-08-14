/**
 * The ONE pod-wide proposal attention fan-out.
 *
 * A pod-wide proposal (`workspaceId === null`) has NO workspace membership to
 * notify, so `NotificationService.fromProposal` (the workspace path) can never
 * fire for it. Its "needs you" attention instead goes to the pod owner + pod
 * admins — pod-wide governance is an owner/admin concern, not every user's.
 *
 * Extracted from `permission-check.ts`'s `notifyProposalCreated` else-branch so
 * the OTHER pod-wide proposal author — the governance TIGHTEN recommender
 * (`services/proposals/recommend-tighten.ts`), which files through the
 * `insertPendingProposal` one-door and therefore never passes through
 * `notifyProposalCreated` — can reuse the identical fan-out instead of growing a
 * second, drifting copy. Both callers live in `@synap/api`, so this is a
 * consolidation, not a duplication.
 *
 * Its own module (not exported from permission-check) deliberately: importing
 * the 1800-line permission-check from a service would drag the whole governance
 * execution graph in and risk an import cycle. This file depends only on
 * NotificationService + pod-owner resolution.
 *
 * IDEMPOTENT: since the `pod-wide-proposal-notify` reactor
 * (`pod-wide-proposal-reactor.ts`) also lands here for EVERY pod-wide
 * `proposal.created` side effect, a proposal filed through a direct caller
 * reaches this function TWICE. The guard lives here, once, so it protects all
 * callers — see `alreadyNotifiedUserIds` below for the key and why it is not a
 * timing assumption.
 *
 * NEVER THROWS: notification failure is non-critical to the WRITE (the proposal
 * is already durably committed by the caller) — but it is never SILENT either.
 * This is the ONLY attention path a pod-wide proposal has; swallowing a failure
 * leaves zero evidence that a human was never told a decision is waiting.
 */

import { createLogger } from "@synap-core/core";
import { db, and, eq, notifications } from "@synap/database";
import { NotificationService } from "./NotificationService.js";
import { resolvePodAdminUserIds } from "../services/capabilities/pod-owner.js";

const logger = createLogger({ module: "notify-pod-wide-proposal" });

/**
 * Recipients that already have a `proposal.created` notification for this
 * proposal. This is the IDEMPOTENCY key of the fan-out: `(sourceType='proposal',
 * sourceId=<proposalId>, type='proposal.created', userId)` is the natural
 * identity of "this human was already told about this proposal", and it is
 * DURABLE STATE — not a timing assumption. It therefore holds regardless of the
 * ORDER in which the callers run, or how far apart:
 *   - the direct caller (`notifyProposalCreated`'s pod-wide else-branch, and
 *     `recommend-tighten`), and
 *   - the event-driven caller (the `pod-wide-proposal-notify` reactor, which
 *     fires off the SAME proposal's `proposal.created` side-effect)
 * cover the same proposal, and whichever lands second is a no-op.
 *
 * It also repairs a PARTIAL fan-out: filtering is per-recipient, so an admin
 * added after the first attempt (or one whose insert failed) still gets told.
 *
 * Deliberately NOT a DB uniqueness constraint: that would need a migration, and
 * a partial unique index on `(source_id, user_id) WHERE type='proposal.created'`
 * would also outlaw legitimate re-notification (e.g. a future re-ping). The
 * residual window is two callers reading this SELECT simultaneously before
 * either INSERT commits — sub-millisecond, and its worst case is the ONE
 * duplicate bell row that exists today unconditionally.
 */
async function alreadyNotifiedUserIds(
  proposalId: string
): Promise<Set<string>> {
  const rows = await db.query.notifications.findMany({
    where: and(
      eq(notifications.sourceType, "proposal"),
      eq(notifications.sourceId, proposalId),
      eq(notifications.type, "proposal.created")
    ),
    columns: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

export async function notifyPodWideProposal(opts: {
  proposalId: string;
  /** Already-composed `${targetType}.${proposalType}` label. */
  proposalType: string;
  description?: string;
  agentUserId?: string;
}): Promise<void> {
  try {
    const recipients = await resolvePodAdminUserIds();
    if (recipients.length === 0) return;
    const alreadyNotified = await alreadyNotifiedUserIds(opts.proposalId);
    const pending = recipients.filter((id) => !alreadyNotified.has(id));
    if (pending.length === 0) return;
    await NotificationService.fromPodWideProposal({
      proposalId: opts.proposalId,
      recipientUserIds: pending,
      proposalType: opts.proposalType,
      description: opts.description,
      agentUserId: opts.agentUserId,
    });
  } catch (err) {
    logger.warn(
      { err, proposalId: opts.proposalId },
      "Pod-wide proposal notification fan-out failed (non-fatal)"
    );
  }
}
