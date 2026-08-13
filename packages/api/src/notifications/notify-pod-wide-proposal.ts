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
 * NEVER THROWS: notification failure is non-critical to the WRITE (the proposal
 * is already durably committed by the caller) — but it is never SILENT either.
 * This is the ONLY attention path a pod-wide proposal has; swallowing a failure
 * leaves zero evidence that a human was never told a decision is waiting.
 */

import { createLogger } from "@synap-core/core";
import { NotificationService } from "./NotificationService.js";
import { resolvePodAdminUserIds } from "../services/capabilities/pod-owner.js";

const logger = createLogger({ module: "notify-pod-wide-proposal" });

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
    await NotificationService.fromPodWideProposal({
      proposalId: opts.proposalId,
      recipientUserIds: recipients,
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
