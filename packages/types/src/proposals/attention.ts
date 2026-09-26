/**
 * PROPOSAL ATTENTION — where a proposal belongs in the person's day.
 *
 * Three answers, one rule, every surface:
 *
 * - `decide`  — a verdict is still the person's to give (pending, or approved
 *               but the write threw and is retryable).
 * - `notice`  — an agent write that EXECUTED without anyone seeing it
 *               (`auto_approved`). The person did not decide it, so it is
 *               owed a glance — the "on your behalf" feed.
 * - `history` — everything already settled by a person (approved, rejected),
 *               or undone, withdrawn, expired — plus session BOOKKEEPING
 *               receipts, which are an agent keeping its own session record
 *               up to date, not work done for the person.
 *
 * Why this exists: the list door's `validated` filter folds `approved` ∪
 * `auto_approved`, so "what agents did for me" mixed writes the person decided
 * with writes nobody saw. Measured 2026-09-25: 30 auto-approved receipts in 7
 * hours against 3 pending decisions, 17 of the 30 `focus_session.*`
 * bookkeeping.
 *
 * PURE and dependency-free at runtime, published as its own LEAF subpath
 * (`@synap-core/types/proposals/attention`) for the same reason as
 * `./intent`: the `./proposals` barrel re-exports `@synap/database` types, and
 * a value import from a barrel is what crashes Hermes. The one import below is
 * `import type` — erased from the emitted JS and absent from the emitted
 * `.d.ts` (it is only read by the non-exported coverage floor).
 *
 * Reads fields ALREADY ON THE WIRE (`status`, `proposalType`, `targetType`),
 * so there is nothing to regenerate or backfill.
 */

import type { ProposalStatus as StoredProposalStatus } from "@synap/database";

export type ProposalAttention = "decide" | "notice" | "history";

/** Every status a proposal row can carry, as stored. */
export const PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "auto_approved",
  "reverted",
  "approval_failed",
  "withdrawn",
  "expired",
] as const;
export type ProposalStatusValue = (typeof PROPOSAL_STATUSES)[number];

// ── Coverage floor ──────────────────────────────────────────────────────────
// The list above must be EXACTLY the DB enum (`ProposalStatus` in
// `@synap/database/schema/proposals.ts`). A status added there and not here —
// or a stale one left here — makes `_Same` resolve to `never` and the types
// build stops. `STATUS_ATTENTION` below is then `satisfies Record<…>`, so a
// status present in the list but not classified also fails the build.
type _Same = [StoredProposalStatus] extends [ProposalStatusValue]
  ? [ProposalStatusValue] extends [StoredProposalStatus]
    ? true
    : never
  : never;
const _statusListMatchesDb: _Same = true;
void _statusListMatchesDb;

/** Attention by status alone — before the bookkeeping demotion. */
export const STATUS_ATTENTION = {
  pending: "decide",
  // Approved, but applying it threw — still a verdict owed (retry or dismiss).
  approval_failed: "decide",
  auto_approved: "notice",
  approved: "history",
  rejected: "history",
  reverted: "history",
  withdrawn: "history",
  expired: "history",
} as const satisfies Record<ProposalStatusValue, ProposalAttention>;

/** The target kind a bookkeeping receipt touches. */
export const SESSION_BOOKKEEPING_TARGET_TYPE = "focus_session";

/** The verbs that make a `focus_session` receipt the session's own record-keeping. */
const SESSION_BOOKKEEPING_VERBS = ["create", "update"] as const;

/**
 * Every stored `proposal_type` spelling of a bookkeeping verb — the bare verb
 * and the `focus_session.`-dotted form (see {@link ProposalAttentionInput}).
 * {@link isSessionBookkeeping} and the list door's SQL filter both read THIS
 * set, so the two can never disagree on what bookkeeping is.
 */
export const SESSION_BOOKKEEPING_PROPOSAL_TYPES: readonly string[] =
  SESSION_BOOKKEEPING_VERBS.flatMap((verb) => [
    verb,
    `${SESSION_BOOKKEEPING_TARGET_TYPE}.${verb}`,
  ]);

export interface ProposalAttentionInput {
  status: string | null | undefined;
  /**
   * The `proposal_type` column. Auto-approved receipts store the dotted
   * `${targetType}.${action}` ("focus_session.update"); pending rows filed
   * through `checkPermissionOrPropose` store the BARE verb ("update"). Both
   * shapes are read.
   */
  proposalType?: string | null;
  /** The `target_type` column — the kind the write touched. */
  targetType?: string | null;
}

/**
 * Is this row an agent updating its own session record (start, progress,
 * status) rather than a write made for the person?
 *
 * `targetType === "focus_session"` alone is NOT enough: stage gates and dev
 * approvals also target a session, and those are decisions. Only the create /
 * update verbs qualify, in either the bare or the `focus_session.`-dotted form.
 */
export function isSessionBookkeeping(input: ProposalAttentionInput): boolean {
  if (input.targetType !== SESSION_BOOKKEEPING_TARGET_TYPE) return false;
  return SESSION_BOOKKEEPING_PROPOSAL_TYPES.includes(input.proposalType ?? "");
}

function isProposalStatus(value: string): value is ProposalStatusValue {
  return Object.prototype.hasOwnProperty.call(STATUS_ATTENTION, value);
}

/**
 * The ONE attention rule. Returns `null` for a status this build does not know
 * (a newer server than client) — an unknown status is never guessed into a
 * bucket. `validated` is a LIST FILTER alias (approved ∪ auto_approved), not a
 * row status, and is deliberately unknown here: it cannot say whether anyone
 * saw the write.
 */
export function resolveProposalAttention(
  input: ProposalAttentionInput
): ProposalAttention | null {
  const status = input.status ?? "";
  if (!isProposalStatus(status)) return null;
  const byStatus: ProposalAttention = STATUS_ATTENTION[status];
  // Bookkeeping only DEMOTES an unseen receipt. A pending session create
  // ("Start X for Y") is still a decision.
  if (byStatus === "notice" && isSessionBookkeeping(input)) return "history";
  return byStatus;
}
