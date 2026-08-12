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
import type { FailureErrorClass } from "../../../connectors/external-dispatch.js";

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
 *    throw CONFLICT — the caller must NOT mark APPROVED; we didn't send and can't
 *    confirm the other attempt did. Surfaces as APPROVAL_FAILED (actionable),
 *    never a silent false-success (the bug the prior unconditional fall-through
 *    to APPROVED introduced).
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
  executor: Pick<typeof db, "update"> = db
): Promise<void> {
  const [claim] = await executor
    .update(proposals)
    .set({ externalDispatchedAt: new Date() })
    .where(
      and(eq(proposals.id, proposalId), isNull(proposals.externalDispatchedAt))
    )
    .returning({ id: proposals.id });

  if (!claim) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This action is already being dispatched — nothing was re-sent.",
    });
  }

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
        code: "INTERNAL_SERVER_ERROR",
        message: `Couldn't apply — ${result.reason ?? "the external action was not dispatched"}.`,
      }),
      { errorClass: result.errorClass, providerRef: result.providerRef }
    );
  }
}
