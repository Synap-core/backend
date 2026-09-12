/**
 * The ONE ordered `proposal.created` attention door.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ────────────────────────────────────────
 * A pod-wide proposal is notified TWICE, by two arms that are both correct in
 * isolation:
 *
 *   1. the WRITER calls `notifyPodWideProposal` directly, and
 *   2. the `pod-wide-proposal-notify` reactor lands in the SAME helper off the
 *      writer's `proposal.created` side effect (that reactor exists so a writer
 *      in `@synap/jobs`, which cannot import this package, is notified at all).
 *
 * `notifyPodWideProposal` carries a durable idempotency guard keyed on
 * `(sourceType, sourceId, type, userId)`, and that guard is correct for any
 * ORDER — but not for SIMULTANEITY. When both arms are started un-awaited they
 * each run the guard's SELECT before either INSERT commits, both see nothing,
 * and both write. Observed live on 2026-09-12: two bell rows 5 ms apart, on a
 * `dev.plan_approval` and again on a peer's.
 *
 * The fix is sequencing, not a new guard: run the direct fan-out to COMPLETION
 * first, then emit — so the reactor has a row to find. The durable guard is
 * still what makes it safe; this only stops the two arms from racing.
 *
 * ── WHY A HELPER RATHER THAN THE SAME FIX FIVE TIMES ───────────────────────
 * Five writers file pod-wide proposals (`permission-check`'s
 * `notifyProposalCreated`, and the four governance recommenders/wardens). Each
 * had its own `void notifyPodWideProposal(...)` + `void emitSideEffects(...)`
 * pair, and an ordering rule copied five times is a rule that will be half-true
 * within a release. `notify-pod-wide-proposal-ordering.tripwire.test.ts` derives
 * the caller set by scanning source and fails if any file other than this one
 * calls `notifyPodWideProposal` directly.
 *
 * The emit stays FIRE-AND-FORGET, as it was at every call site: it feeds
 * automations, never the human's bell, and nothing may wait on it.
 */

import { emitSideEffects } from "@synap/events";
import { notifyPodWideProposal } from "./notify-pod-wide-proposal.js";

/** The pod-wide fan-out's arguments — see `notifyPodWideProposal`. */
export interface PodWideProposalNotification {
  proposalId: string;
  /** Already-composed `${targetType}.${proposalType}` label. */
  proposalType: string;
  description?: string;
  agentUserId?: string;
}

/**
 * The `proposal.created` side effect, minus the two constants this door owns.
 * Keeping `subjectType`/`action` here is what makes "the emit the reactor
 * listens for" a single spelling rather than five.
 */
export interface ProposalCreatedSideEffect {
  subjectId: string;
  userId: string;
  workspaceId?: string | null;
  data?: Record<string, unknown>;
}

export async function notifyProposalCreatedOrdered(opts: {
  /**
   * The pod-wide fan-out, or `null` when there is nothing to fan out: a
   * WORKSPACE-scoped proposal (its attention is `NotificationService.from
   * Proposal`, and the reactor explicitly bails on those), or a dedup hit whose
   * row already notified when it was first filed.
   */
  podWide: PodWideProposalNotification | null;
  /** Emitted AFTER the fan-out. `null` ⇒ this writer emits nothing. */
  sideEffect: ProposalCreatedSideEffect | null;
  /** Reported rather than swallowed — the emit is best-effort, not invisible. */
  onEmitError?: (err: unknown) => void;
}): Promise<void> {
  // AWAITED, and first. That is the whole ordering rule. `notifyPodWideProposal`
  // never throws (it logs its own failures non-fatally), so this cannot fail the
  // caller's write.
  if (opts.podWide) await notifyPodWideProposal(opts.podWide);

  if (!opts.sideEffect) return;
  void emitSideEffects({
    subjectType: "proposal",
    action: "created",
    ...opts.sideEffect,
  }).catch((err) => opts.onEmitError?.(err));
}
