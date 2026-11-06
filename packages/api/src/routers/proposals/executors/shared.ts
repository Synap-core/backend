/**
 * Shared header helpers for the approve executors, split out of
 * `approve-executors.ts` (Wave 1 router decomposition). LEAF module — must
 * NOT import any executor module or the aggregator; only the registry types
 * it needs to build `reportApproved`/`dispatchExternalOnce`.
 */

import { TRPCError } from "@trpc/server";
import { db, proposals, eq, and, isNull } from "@synap/database";
import {
  attachFailureMeta,
  type ProposalExecutorDeps,
  type ProposalRow,
} from "../execution-registry.js";
import { leaveRowToOtherAttempt } from "../failure-classification.js";
import { ProposalStatus } from "@synap/database/schema";
import type { FailureErrorClass } from "../../../connectors/external-dispatch.js";
import { redactForStorage } from "../../../utils/redact-secrets.js";
import { CLASS_TRPC_CODE } from "../failure-classification.js";
import { isNestedEnvelope } from "@synap-core/types/proposals";

/**
 * Bound on the PROVIDER-authored fragment interpolated into the sentence below.
 *
 * `result.reason` is NOT author-written. It originates in
 * `extractProviderErrorMessage` (`connectors/external-dispatch.ts`), which
 * returns the far side's own `error.message` — unbounded, unredacted, and
 * routinely echoing the `Authorization` header that produced it. Interpolating
 * it into a `TRPCError` message made it "author-written" by construction, and
 * every downstream reader (`safeFailureSentence` → `rejectionReason` →
 * `render-for-prompt`'s trusted `- What the user is shown:` line) trusted that
 * label. Redact and clamp at the SOURCE; the sink redacts again.
 */
const PROVIDER_REASON_MAX = 200;

/**
 * Fire the "approved" IS-telemetry outcome (fire-and-forget — never blocks).
 * Extracted verbatim from the ~38 byte-identical call sites across the approve
 * executors below; the argument construction is unchanged.
 */
export function reportApproved(
  deps: ProposalExecutorDeps,
  proposal: ProposalRow,
  proposalId: string
): void {
  deps.reportProposalOutcome({
    proposalId,
    outcome: "approved",
    sourceMessageId: proposal.sourceMessageId,
    agentUserId: proposal.agentUserId,
    targetType: proposal.targetType,
    proposalType: proposal.proposalType,
    source: (proposal.data as Record<string, unknown> | null)?.source as
      string | undefined,
  });
}

/**
 * At-most-once external dispatch with the ratified HYBRID failure policy — the
 * ONE door for the four irreversible external executors (messaging.external.send,
 * capability.run, provider.action, capability/run). Wraps the side effect so it
 * fires at most once and, critically, so the proposal NEVER flips to APPROVED
 * unless the side effect is confirmed delivered:
 *
 *  - CAS-claims `external_dispatched_at` before running. Claim LOST (a prior
 *    attempt that failed-and-kept its claim, or a concurrent approval owns it):
 *    throw — the caller must NOT mark APPROVED; we didn't send. The error says
 *    which of those it is, read from the row (`claimLostError`), never a false
 *    success and never a false "being dispatched".
 *  - `send()` returns `{ delivered: false }` — a DEFINITE not-sent (connector
 *    refused, skill not_found/deny, provider !executed): RELEASE the claim so a
 *    Retry re-dispatches cleanly, then throw.
 *  - `send()` THROWS — ambiguous (the call may have reached the far side): KEEP
 *    the claim (at-most-once: never risk a double-send on retry) and rethrow.
 *    Lands APPROVAL_FAILED — honestly "uncertain", not falsely sent.
 *  - `send()` returns `{ delivered: true }`: return normally; caller marks
 *    APPROVED exactly once.
 *
 * The `send` closure OWNS its own logging of the specific failure reason (this
 * helper only knows delivered-or-not) and captures any result into caller-scoped
 * variables for the materialized payload.
 */
export async function dispatchExternalOnce(
  proposalId: string,
  send: () => Promise<
    // P1: a not-delivered result MAY carry structured failure scalars (from the
    // dispatch envelope) so the thrown error can propagate a next action.
    | {
        delivered: false;
        reason?: string;
        errorClass?: FailureErrorClass;
        providerRef?: string;
      }
    | { delivered: true }
  >,
  executor: Pick<typeof db, "update" | "select"> = db
): Promise<void> {
  const [claim] = await executor
    .update(proposals)
    .set({ externalDispatchedAt: new Date() })
    .where(
      and(eq(proposals.id, proposalId), isNull(proposals.externalDispatchedAt))
    )
    .returning({ id: proposals.id });

  if (!claim) throw await claimLostError(proposalId, executor);

  const result = await send(); // ambiguous throw → claim kept, propagates

  if (!result.delivered) {
    await executor
      .update(proposals)
      .set({ externalDispatchedAt: null })
      .where(eq(proposals.id, proposalId));
    // P1: attach the structured failure scalars so `dispatchProposalApproval`'s
    // catch can persist a next action alongside the human message (unchanged).
    throw attachFailureMeta(
      new TRPCError({
        // A DEFINITE not-delivered is the far side refusing, never our crash:
        // a classified refusal keeps its own code (auth → UNAUTHORIZED …); an
        // unclassified one (a code skill's own `throw`) is a 422, which the
        // classifier reads back as `validation` — not a 500 / `unknown`.
        code:
          result.errorClass && result.errorClass !== "unknown"
            ? CLASS_TRPC_CODE[result.errorClass]
            : "UNPROCESSABLE_CONTENT",
        message: `Couldn't apply — ${
          result.reason
            ? // The sentence ends here with its own full stop: a reason that
              // already ends with one read "run it again.." (fff9cebc).
              redactForStorage(result.reason, PROVIDER_REASON_MAX).replace(
                /[.\s]+$/,
                ""
              )
            : "the external action was not dispatched"
        }.`,
      }),
      { errorClass: result.errorClass, providerRef: result.providerRef }
    );
  }
}

/**
 * A claim held this long by an attempt that never recorded an end did not
 * finish (its process died): no external send in an approval runs this long.
 */
export const STALE_DISPATCH_CLAIM_MS = 15 * 60 * 1000;

/**
 * Why the claim was lost, said from the row — never a blanket "already being
 * dispatched". That sentence was shown when nothing was running and nothing
 * had been sent (e74a086c): a double approval whose twin had already failed
 * and released the claim. Four facts, four sentences:
 *
 *  - the row is approved: the other attempt sent it;
 *  - the claim is free again: the other attempt ended without sending (its
 *    reason is on the row), so approving again really retries;
 *  - the claim is held by an attempt that ENDED (the failure was recorded
 *    after the claim) or that stopped long ago: the send may have reached the
 *    far side, so this proposal can never be sent again — a refusal that says
 *    so, and is recorded on the row;
 *  - otherwise an approval is running right now.
 *
 * In the first, second and fourth case the row belongs to the OTHER attempt,
 * which records its own outcome: the error is marked so the approval catch
 * does not write this attempt's sentence over it.
 */
async function claimLostError(
  proposalId: string,
  executor: Pick<typeof db, "select">
): Promise<TRPCError> {
  const [row] = await executor
    .select({
      status: proposals.status,
      externalDispatchedAt: proposals.externalDispatchedAt,
      reviewedAt: proposals.reviewedAt,
    })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);

  if (!row) {
    return new TRPCError({
      code: "NOT_FOUND",
      message: "This proposal no longer exists. Nothing was sent.",
    });
  }
  if (row.status === ProposalStatus.APPROVED) {
    return leaveRowToOtherAttempt(
      new TRPCError({
        code: "CONFLICT",
        message:
          "This action already ran: another approval sent it. Nothing was sent again.",
      })
    );
  }
  const claimedAt = row.externalDispatchedAt;
  if (!claimedAt) {
    return leaveRowToOtherAttempt(
      new TRPCError({
        code: "CONFLICT",
        message:
          "Another approval of this action just ran and did not go through, so nothing was sent. Its reason is on the proposal; fix it, then approve again.",
      })
    );
  }
  const ended =
    row.status === ProposalStatus.APPROVAL_FAILED &&
    row.reviewedAt !== null &&
    row.reviewedAt.getTime() >= claimedAt.getTime();
  const stale = Date.now() - claimedAt.getTime() > STALE_DISPATCH_CLAIM_MS;
  if (ended || stale) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "An earlier approval of this action stopped without a clear answer, so it may already have reached the service. Nothing was sent again: check the service, and if nothing happened there, ask for a new run.",
    });
  }
  return leaveRowToOtherAttempt(
    new TRPCError({
      code: "CONFLICT",
      message:
        "Another approval of this action is running right now. Nothing was sent again; its result will show on this proposal.",
    })
  );
}

/**
 * Guard: an approve executor's replay must APPLY, never re-propose.
 *
 * Executors materialize a proposal by re-running the SAME router mutation the
 * direct path uses, as the APPROVER. That mutation calls
 * `checkPermissionOrPropose` again, and the gate can legitimately answer
 * "proposed" for a caller who lacks the permission — so the replay can file a
 * SECOND proposal instead of applying the first.
 *
 * That is always wrong, and it fails SILENTLY: the executor marks the original
 * APPROVED, the reviewer sees success, nothing is written, and a fresh pending
 * proposal appears with no explanation.
 *
 * It is reachable today: `canReviewProposal` treats `isOwner` as "approver IS
 * the proposer" (`proposals.ts` — `data?.sourceId === reviewerId`), so under the
 * default `owner_and_admins` policy a member whose ROLE cannot execute the write
 * can still approve their OWN proposal. The replay then re-enters the same
 * insufficient-role branch that created it.
 *
 * Throwing converts a silent no-op into a loud, diagnosable failure and leaves
 * the original proposal PENDING (the status update runs after this), so a
 * reviewer with sufficient authority can still approve it.
 */
export function assertApplied(result: { status?: string } | undefined): void {
  if (result?.status === "proposed") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Approval could not be applied: your workspace role cannot execute this write, so re-running it only filed another proposal. Ask a workspace admin or owner to approve.",
    });
  }
}

/**
 * The caller's fields of a stored proposal, read where the filer put them.
 *
 * `checkPermissionOrPropose` files a pending proposal as a request-shaped
 * envelope with the caller's object NESTED at `data.data`; a door that writes
 * its row directly stores the fields flat. Which one a row is comes from the ONE
 * nesting contract (`isNestedEnvelope`), the predicate the revise core also
 * branches on — so an approval reads the slot a revision wrote.
 *
 * Reading the envelope flat is how a reviewed document landed "Untitled" with
 * an empty body, and how three channel approvals handed their writes no target.
 */
export function storedProposalFields(
  proposal: Pick<ProposalRow, "data">
): Record<string, unknown> {
  const stored = (proposal.data ?? {}) as Record<string, unknown>;
  return (isNestedEnvelope(stored) ? stored.data : stored) as Record<
    string,
    unknown
  >;
}
