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
 *
 * THE TRANSITION (reactions W1): every move also OWES a
 * `proposal.transition.completed` (the one transition shape, categories from
 * `PROPOSAL_STATUS_DECLARATION`) in the SAME STATEMENT as the write: the
 * lock, the outbox insert and the UPDATE are one `WITH … UPDATE`, atomic on
 * any executor, with no transaction or savepoint of its own (see
 * {@link transitionProposal}). The call keeps the builder's contract (await
 * it, or chain `.returning(…)`), so its ~150 call sites are unchanged. The
 * sweeper delivers the transition (the old `proposal.approved` / `.rejected`
 * events stay, emitted by `emitProposalReviewed`, as dual emits).
 */
import { and, inArray, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { PROPOSAL_STATUS_DECLARATION } from "@synap-core/types/units";
import { DOCUMENT_PATCH_PROPOSAL_TYPES } from "@synap-core/types/proposals/intent";
// Type-only: the door runs on the executor it is handed, never on a pool it
// opens itself (a PGlite test or a transaction passes its own).
import type { db } from "../client-pg.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";
import { lifecycleTransitionOutbox } from "../schema/lifecycle-transition-outbox.js";
import type { WorkUnitActor } from "../services/lifecycle/work-unit-transition.js";
import { transitionStamp } from "../services/lifecycle/transition-stamp.js";
import { getActingAgentUserId } from "./request-write-context.js";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Anything that can run the move: the pod's db or a transaction. Typed as
 * narrowly as the callers declare it (some hand a "stamp db" typed with
 * `update` only); at runtime every caller hands a db or a transaction, whose
 * `$with` / `with` the door builds its one statement with.
 */
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

/** The CTE that locks the rows a move matches (the compare-and-set). */
const LOCKED_CTE = "proposal_transition_locked";
/** The CTE that owes their transitions (the outbox insert). */
const OWED_CTE = "proposal_transition_owed";

/** `CASE <expr> WHEN '<status>' THEN '<category>' … END`, from the declaration. */
function categoryCaseSql(expr: SQL): SQL {
  const whens = Object.entries(PROPOSAL_STATUS_DECLARATION)
    .map(([status, { category }]) => `WHEN '${status}' THEN '${category}'`)
    .join(" ");
  return sql`CASE ${expr} ${sql.raw(whens)} END`;
}

/**
 * The document section a `document/*` patch proposal addresses, as SQL over
 * the proposal row `p`: the document (its target) and the section ids its
 * ops name (the payload nested under `data` or flat, as the patch doors file
 * it). Null for any other proposal. A proposed section joins the door as its
 * proposal (reactions W1).
 */
function sectionSql(): SQL {
  const types = sql.raw(
    DOCUMENT_PATCH_PROPOSAL_TYPES.map((t) => `'${t}'`).join(", ")
  );
  return sql`CASE WHEN p.target_type = 'document' AND p.proposal_type IN (${types})
    THEN jsonb_build_object(
      'documentId', p.target_id,
      'sectionIds', COALESCE((
        SELECT jsonb_agg(DISTINCT s.v)
          FROM jsonb_path_query(
            CASE WHEN jsonb_typeof(p.data->'data') = 'object'
                  AND jsonb_typeof(p.data->'ops') IS DISTINCT FROM 'array'
                 THEN p.data->'data' ELSE p.data END,
            '$.ops[*].sectionId') AS s(v)
         WHERE jsonb_typeof(s.v) = 'string' AND s.v <> '""'::jsonb
      ), '[]'::jsonb))
    ELSE NULL END`;
}

/**
 * Move the matching proposals to `to` in ONE STATEMENT that also checks the
 * transition table and owes each move's transition: `status IN (from)` is
 * AND-ed to the caller's `where`, so a row in a status that may not become
 * `to` is left untouched.
 *
 *   WITH locked AS (SELECT … WHERE <where> AND status IN (from)
 *                   ORDER BY id FOR UPDATE),
 *        owed   AS (INSERT INTO lifecycle_transition_outbox
 *                   SELECT <the transition> FROM locked JOIN proposals …
 *                   WHERE prior status <> to)
 *   UPDATE proposals SET … WHERE <where> AND status IN (from)
 *                          AND id IN (SELECT id FROM locked)
 *
 * One statement is atomic on any executor — the pod's db, or a caller's open
 * transaction (no savepoint) — so the move and its debt can never part. The
 * locked CTE takes the rows in id order, so two bulk moves cannot deadlock.
 *
 * `from` narrows the guard to the statuses this caller moves (each must be
 * allowed by the table: a disallowed one throws, it is a programming error).
 * Omitted, every status the table lets reach `to` matches.
 *
 * `actor` attributes the move; absent, it is the person named as reviewer in
 * `set.reviewedBy` (an approval, a rejection), else the request's acting
 * agent, else the system (a sweep, an expiry). The transition's person is the
 * actor's, else the proposal's (who filed it, whose principal authored it,
 * its author).
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
    actor?: WorkUnitActor;
    reason?: string | null;
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
  const guard = and(args.where, inArray(proposals.status, [...from]));
  // One builder type: a transaction's `with` / `$with` build the same
  // statement (see `ProposalStatusWriter`).
  const ex = executor as unknown as typeof db;

  const locked = ex.$with(LOCKED_CTE, { id: sql<string>`id` }).as(
    sql`SELECT ${proposals.id} AS id, ${proposals.status} AS prior_status
            FROM ${proposals}
           WHERE ${guard}
           ORDER BY ${proposals.id}
             FOR UPDATE`
  );

  const actor = args.actor ?? defaultActor(args.set);
  const stamp = transitionStamp(actor.kind, null);
  const setReason = args.set?.rejectionReason;
  // A refusal's or a failure's sentence is its reason; never a stale one.
  const reason =
    args.reason ??
    ((args.to === ProposalStatus.REJECTED ||
      args.to === ProposalStatus.APPROVAL_FAILED) &&
    typeof setReason === "string"
      ? setReason
      : null);
  const toCategory = PROPOSAL_STATUS_DECLARATION[args.to].category;
  const owed = ex.$with(OWED_CTE, { id: sql<string>`transition_id` }).as(
    sql`INSERT INTO ${lifecycleTransitionOutbox} (transition_id, transition, emit_context)
        SELECT m.tid, jsonb_build_object(
          'transitionId', m.tid,
          'subjectType', 'proposal',
          'subjectId', p.id,
          'property', 'status',
          'from', m.prior_status,
          'to', ${args.to}::text,
          'fromCategory', ${categoryCaseSql(sql`m.prior_status`)},
          'category', ${toCategory}::text,
          'actorKind', ${actor.kind}::text,
          'actorClass', ${stamp.actorClass}::text,
          'appId', ${stamp.appId}::text,
          'userId', COALESCE(${actor.userId ?? null}::text, p.proposed_by_user_id,
                             p.subject_user_id, p.created_by, p.agent_user_id, 'system'),
          'agentUserId', ${actor.agentUserId ?? null}::text,
          'sessionId', p.session_id,
          'reason', ${reason}::text,
          'staleExpected', false,
          'proposalId', p.id,
          'workspaceId', p.workspace_id,
          'occurredAt', ${stamp.occurredAt}::text,
          'recordedAt', ${stamp.recordedAt}::text,
          'backdated', false,
          'hold', NULL::jsonb,
          'proposalType', p.proposal_type,
          'targetType', p.target_type,
          'targetId', p.target_id,
          'section', ${sectionSql()}
        ), '{}'::jsonb
          FROM (SELECT l.id, l.prior_status, gen_random_uuid() AS tid
                  FROM ${sql.raw(LOCKED_CTE)} l
                 WHERE l.prior_status <> ${args.to}::text) m
          JOIN ${proposals} p ON p.id = m.id
        RETURNING transition_id`
  );

  return ex
    .with(locked, owed)
    .update(proposals)
    .set({ ...(args.set ?? {}), status: args.to })
    .where(
      and(
        guard,
        sql`${proposals.id} IN (SELECT id FROM ${sql.raw(LOCKED_CTE)})`
      )
    );
}

/** Who made a move nobody named: the reviewer, the acting agent, the system. */
function defaultActor(set: ProposalTransitionSet | undefined): WorkUnitActor {
  const reviewer = set?.reviewedBy;
  if (typeof reviewer === "string" && reviewer.length > 0) {
    return { kind: "human", userId: reviewer };
  }
  const agent = getActingAgentUserId();
  return agent ? { kind: "agent", agentUserId: agent } : { kind: "system" };
}
