/**
 * A pending proposal's FATE on the pod's wire, and the Review later predicate
 * every COUNT reads (pod doc 86890dee).
 *
 * The rule is `proposalFate` (`@synap-core/types/proposals/fate`). This
 * module only feeds it the class fields from the ONE class door
 * (`proposalClassFields`), so a row's fate and its class can never disagree.
 *
 * ── Why a SQL twin ─────────────────────────────────────────────────────────
 * A count must not load rows (orient runs on every session start;
 * `readPendingReviewState`). So "is this proposal in Review later?" also exists
 * as a WHERE clause, {@link reviewLaterProposalWhere}. It is built from the
 * same inputs as the TS rule — `REVIEW_LATER_AFTER_MS`, the class tables of
 * `proposal-class.ts` and the document-edit types — and
 * `proposal-fate.pglite.test.ts` evaluates both over a fixture matrix and fails
 * on any row where they disagree.
 */

import {
  drizzleSql,
  proposals,
  SUPERSEDED_BY_KEY,
  type SQL,
} from "@synap/database";
import {
  REVIEW_LATER_AFTER_MS,
  isReviewLater,
  proposalFate,
  type ProposalFate,
  type ProposalFateInput,
} from "@synap-core/types/proposals/fate";
import { DOCUMENT_EDIT_PROPOSAL_TYPES } from "@synap-core/types/proposals/intent";
import {
  ACCESS_DOORS,
  CAPABILITY_RUN_PROPOSAL_TYPE,
  CLASS_LIFETIME_HOURS,
  DURABLE_OBJECT_VERBS,
  capabilityRunVerbId,
  proposalClassFields,
} from "./proposal-class.js";

/** What the fate reads off a proposal row — every column already selected by the read doors. */
export interface ProposalFateRow {
  proposalType: string;
  targetType: string;
  /** Read only for a capability run's `verbId` (its class). */
  data?: unknown;
  createdAt: Date | string;
  sessionId?: string | null;
}

function proposalFateInput(
  row: ProposalFateRow,
  now: Date | number
): ProposalFateInput {
  const cls = proposalClassFields(
    row.proposalType,
    row.targetType,
    capabilityRunVerbId(row.data)
  );
  return {
    proposalClass: cls.class,
    lifetimeHours: cls.lifetimeHours,
    createdAt: row.createdAt,
    targetType: row.targetType,
    proposalType: row.proposalType,
    sessionId: row.sessionId ?? null,
    now,
  };
}

/** Is this proposal in the Review later pile? The TS side of the one rule. */
export function isProposalReviewLater(
  row: ProposalFateRow,
  now: Date | number = Date.now()
): boolean {
  return isReviewLater(proposalFateInput(row, now));
}

/**
 * The `fate` field every read door stamps — present on a PENDING row only:
 * fate is what happens on silence, and a decided proposal has no silence left.
 */
export function proposalFateFields(
  row: ProposalFateRow & { status?: string | null },
  now: Date | number = Date.now()
): { fate?: ProposalFate } {
  if (row.status !== "pending") return {};
  return { fate: proposalFate(proposalFateInput(row, now)) };
}

/**
 * A withdrawn proposal REPLACED by a newer version of itself (the supersede
 * rule, `insertPendingProposal`): the newer proposal's id, lifted off the
 * stamp so a review screen can say "Replaced by a newer version" and open it.
 */
export function supersededByFields(row: {
  status?: string | null;
  data?: unknown;
}): { supersededBy?: string } {
  if (row.status !== "withdrawn" || !row.data || typeof row.data !== "object")
    return {};
  const id = (row.data as Record<string, unknown>)[SUPERSEDED_BY_KEY];
  return typeof id === "string" && id ? { supersededBy: id } : {};
}

function sqlList(values: Iterable<string>): SQL {
  return drizzleSql.join(
    [...values].map((v) => drizzleSql`${v}`),
    drizzleSql`, `
  );
}

/**
 * SQL: the proposal row is in Review later at `now`. The twin of
 * {@link isProposalReviewLater}, clause for clause in `proposalFate`'s order:
 *   1. a class WITH a lifetime expires instead — so only `objectWork`, and
 *      only while `objectWork` has no lifetime (checked here, not assumed);
 *   2. a session-bound draft with a session dies with it instead;
 *   3. created more than `REVIEW_LATER_AFTER_MS` before `now`.
 * The `objectWork` arm is `classifyProposal` read backwards: a capability run
 * is objectWork only for a durable-object verb; anything else is objectWork
 * unless it is governance, an access pair or a merge.
 */
export function reviewLaterProposalWhere(now: Date = new Date()): SQL {
  if (CLASS_LIFETIME_HOURS.objectWork !== null) return drizzleSql`false`;
  const p = proposals;
  const objectWork = drizzleSql`(CASE
    WHEN ${p.proposalType} = ${CAPABILITY_RUN_PROPOSAL_TYPE} AND ${p.targetType} = 'capability'
      THEN coalesce(${p.data} ->> 'verbId', '') IN (${sqlList(DURABLE_OBJECT_VERBS)})
    ELSE NOT (
      ${p.proposalType} LIKE 'governance.%'
      OR (${p.targetType} || '/' || ${p.proposalType}) IN (${sqlList(ACCESS_DOORS)})
      OR ${p.proposalType} = 'merge'
    )
  END)`;
  const sessionBoundDraft = drizzleSql`(${p.sessionId} IS NOT NULL AND ${p.targetType} = 'document' AND ${p.proposalType} IN (${sqlList(DOCUMENT_EDIT_PROPOSAL_TYPES)}))`;
  const cutoff = new Date(now.getTime() - REVIEW_LATER_AFTER_MS);
  return drizzleSql`(${objectWork} AND NOT ${sessionBoundDraft} AND ${p.createdAt} < ${cutoff.toISOString()}::timestamptz)`;
}
