/**
 * THE ONE DOOR that writes `proposals.status`.
 *
 * Before this module the status had about 140 writers in 62 files, each with
 * its own `WHERE` (or none) and no shared rule for which move is allowed. That
 * is how an approved proposal could be relabelled `rejected` by a job, how the
 * reject door could overwrite an approval, and how an executor could report
 * success while the row stayed `pending` (#427). Every status write now goes
 * through {@link transitionProposal}, which adds the transition table's guard
 * to the caller's own predicate. Tripwire `proposal-status-one-door`
 * (packages/api/src/__tripwires__) fails when any other file writes the column.
 *
 * The table is the transitions the pod actually makes (read from every writer
 * on 2026-10-28), not an ideal: each row names its writer. A move it does not
 * list matches no row, so the write is a no-op — never an overwrite.
 *
 * Not here, on purpose: inserts. A new proposal is born with its status
 * (`pending`, or `auto_approved` for a receipt); that is not a transition.
 */
import { and, inArray, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
// Type-only: the door runs on the executor it is handed, never on a pool it
// opens itself (a PGlite test or a transaction passes its own).
import type { db } from "../client-pg.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Anything that can run the UPDATE: the pod's db, a transaction, a stamp db. */
export type ProposalStatusWriter =
  Pick<typeof db, "update"> | Pick<DbTx, "update">;

/** Every column but the status (the door writes it) and the id (never moves). */
export type ProposalTransitionSet = Omit<
  PgUpdateSetSource<typeof proposals>,
  "status" | "id"
>;

const {
  PENDING,
  APPROVED,
  REJECTED,
  AUTO_APPROVED,
  REVERTED,
  APPROVAL_FAILED,
  WITHDRAWN,
  EXPIRED,
} = ProposalStatus;

/**
 * from → the statuses it may move to. A self-move (`approved → approved`) is a
 * re-stamp some doors make today (an executor with no already-approved guard,
 * a second reject); it is listed so those writes behave as before.
 */
export const PROPOSAL_TRANSITIONS: Readonly<
  Record<ProposalStatus, readonly ProposalStatus[]>
> = {
  // Approve (every executor, the shared approval tail), reject, withdraw (the
  // proposer), expire (the lapse scanners, goal end, cleanup packs, a landed
  // record), approval failed (the tail's failure write), auto-approved (an
  // agent's own revised graph capture re-decided under its rule,
  // `redecide-graph-revision.ts`, #512).
  [PENDING]: [
    APPROVED,
    REJECTED,
    WITHDRAWN,
    EXPIRED,
    APPROVAL_FAILED,
    AUTO_APPROVED,
  ],
  // A failed approval stays in the actionable queue: retried (approved, or
  // failed again) or rejected; or its author revises it, which reopens it
  // for review (`proposals-service.ts` revise, #512).
  [APPROVAL_FAILED]: [APPROVED, APPROVAL_FAILED, REJECTED, PENDING],
  // Re-stamp; revert; revert-and-reopen (`proposals.revert {reopen}`); a
  // library organise claim given back after a later step threw.
  [APPROVED]: [APPROVED, REVERTED, PENDING, APPROVAL_FAILED],
  // An applied receipt: re-approved (re-runs the executor today), reverted,
  // reopened by revert, or marked failed when its materialization threw
  // (`runMaterializationUnderReceipt`).
  [AUTO_APPROVED]: [APPROVED, REVERTED, PENDING, APPROVAL_FAILED],
  // Reopen puts it back in the queue; a second reject re-stamps it.
  [REJECTED]: [PENDING, REJECTED],
  // Reopen of a reverted proposal (`proposals.revert {reopen}`).
  [REVERTED]: [PENDING],
  // Final: the proposer took it back, or its moment passed.
  [WITHDRAWN]: [],
  [EXPIRED]: [],
};

/** May a proposal in `from` move to `to`? Pure; the door's guard is built from it. */
export function canTransitionProposal(
  from: ProposalStatus,
  to: ProposalStatus
): boolean {
  return PROPOSAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Every status the table lets reach `to`. */
export function proposalStatusesThatMayBecome(
  to: ProposalStatus
): ProposalStatus[] {
  return (Object.keys(PROPOSAL_TRANSITIONS) as ProposalStatus[]).filter(
    (from) => canTransitionProposal(from, to)
  );
}

/** The statuses that mean "the approval applied". */
export const APPLIED_PROPOSAL_STATUSES: readonly ProposalStatus[] = [
  APPROVED,
  AUTO_APPROVED,
];

/**
 * Move the matching proposals to `to`, in ONE UPDATE that also checks the
 * transition table: `status IN (from)` is AND-ed to the caller's `where`, so a
 * row in a status that may not become `to` is left untouched.
 *
 * `from` narrows the guard to the statuses this caller moves (each must be
 * allowed by the table: a disallowed one throws, it is a programming error).
 * Omitted, every status the table lets reach `to` matches.
 *
 * Returns the UPDATE builder, so a caller chains `.returning(...)` exactly as
 * it would on `db.update(proposals)`; awaiting it runs the statement.
 */
export function transitionProposal(
  executor: ProposalStatusWriter,
  args: {
    to: ProposalStatus;
    where: SQL | undefined;
    from?: readonly ProposalStatus[];
    set?: ProposalTransitionSet;
  }
) {
  const from = args.from ?? proposalStatusesThatMayBecome(args.to);
  const refused = from.filter((s) => !canTransitionProposal(s, args.to));
  if (refused.length > 0) {
    throw new Error(
      `transitionProposal: ${refused.join(", ")} → ${args.to} is not in PROPOSAL_TRANSITIONS`
    );
  }
  if (from.length === 0) {
    throw new Error(`transitionProposal: nothing may become ${args.to}`);
  }
  // One builder type: a transaction's `update` builds the same statement.
  return (executor as Pick<typeof db, "update">)
    .update(proposals)
    .set({ ...(args.set ?? {}), status: args.to })
    .where(and(args.where, inArray(proposals.status, [...from])));
}
