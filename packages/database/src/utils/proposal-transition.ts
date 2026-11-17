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
 * `PROPOSAL_STATUS_DECLARATION`) in the SAME transaction as the write — the
 * caller's own when it hands a transaction (a savepoint), else one of its own:
 *   1. lock the rows the caller's `where` AND the table's guard match, in id
 *      order (the compare-and-set);
 *   2. ONE UPDATE writes the status and the caller's `set` on those rows;
 *   3. each row whose status changed owes its transition through the outbox.
 * The call keeps the builder's contract (await it, or chain `.returning(…)`)
 * so its ~150 call sites are unchanged: what it returns is a lazy query that
 * runs the three steps once. The sweeper delivers the transition (the old
 * `proposal.approved` / `.rejected` events stay, emitted by
 * `emitProposalReviewed`, as dual emits).
 */
import { and, asc, inArray, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { PROPOSAL_STATUS_DECLARATION } from "@synap-core/types/units";
import { DOCUMENT_PATCH_PROPOSAL_TYPES } from "@synap-core/types/proposals/intent";
import type {
  ProposalSectionRef,
  ProposalTransitionPayload,
} from "@synap-core/types/lifecycle";
// Type-only: the door runs on the executor it is handed, never on a pool it
// opens itself (a PGlite test or a transaction passes its own).
import type { db } from "../client-pg.js";
import { proposals, ProposalStatus } from "../schema/proposals.js";
import { insertTransitionOutbox } from "../services/lifecycle/transition-outbox.js";
import {
  transitionBaseOf,
  type WorkUnitActor,
} from "../services/lifecycle/work-unit-transition.js";
import { getActingAgentUserId } from "./request-write-context.js";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Anything that can run the move: the pod's db or a transaction. Typed as
 * narrowly as the callers declare it (some hand a "stamp db" typed with
 * `update` only); at runtime every caller hands a db or a transaction, which
 * is what the door uses (a savepoint inside a caller's transaction).
 */
export type ProposalStatusWriter =
  Pick<typeof db, "update"> | Pick<DbTx, "update">;

/** A stored proposal row. */
export type ProposalRow = typeof proposals.$inferSelect;

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

/** What a move moved, as `.returning(fields)` asks for it. */
type Projected<K extends keyof ProposalRow> = Pick<ProposalRow, K>;

/**
 * The lazy query `transitionProposal` returns: await it for the moved rows,
 * or `.returning({ id: proposals.id, … })` for those columns of them (each
 * key named as the column's own property, as every call site does).
 */
export interface ProposalTransitionQuery extends PromiseLike<ProposalRow[]> {
  returning(): Promise<ProposalRow[]>;
  returning<K extends keyof ProposalRow>(fields: {
    [P in K]: (typeof proposals)[P];
  }): Promise<Array<Projected<K>>>;
}

/**
 * Move the matching proposals to `to` — lock, ONE UPDATE that also checks the
 * transition table, and one owed transition per row that moved, in one
 * transaction: `status IN (from)` is AND-ed to the caller's `where`, so a row
 * in a status that may not become `to` is left untouched.
 *
 * `from` narrows the guard to the statuses this caller moves (each must be
 * allowed by the table: a disallowed one throws, it is a programming error).
 * Omitted, every status the table lets reach `to` matches.
 *
 * `actor` attributes the move; absent, it is the person named as reviewer in
 * `set.reviewedBy` (an approval, a rejection), else the acting agent of the
 * request, else the system (a sweep, an expiry).
 *
 * Returns a lazy query: awaiting it (or its `.returning(…)`) runs the move
 * once and yields the moved rows.
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
): ProposalTransitionQuery {
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
  let run: Promise<ProposalRow[]> | null = null;
  const moved = () => (run ??= moveProposals(executor, { ...args, from }));
  return {
    then(onFulfilled, onRejected) {
      return moved().then(onFulfilled, onRejected);
    },
    returning(fields?: Record<string, unknown>) {
      return moved().then((rows) =>
        fields ? rows.map((row) => project(row, fields)) : rows
      );
    },
  } as ProposalTransitionQuery;
}

/** A column object → its property name on the row. */
const PROPERTY_OF = new Map<unknown, keyof ProposalRow>(
  (Object.keys(proposals) as Array<keyof typeof proposals>)
    .filter((k) => typeof k === "string")
    .map((k) => [proposals[k], k as keyof ProposalRow])
);

function project(
  row: ProposalRow,
  fields: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(fields)) {
    const prop = PROPERTY_OF.get(column) ?? (key as keyof ProposalRow);
    out[key] = row[prop];
  }
  return out;
}

async function moveProposals(
  executor: ProposalStatusWriter,
  args: {
    to: ProposalStatus;
    where: SQL | undefined;
    from: readonly ProposalStatus[];
    set?: ProposalTransitionSet;
    actor?: WorkUnitActor;
    reason?: string | null;
  }
): Promise<ProposalRow[]> {
  // A db opens a transaction; a caller's transaction a savepoint — the same
  // call at runtime (see `ProposalStatusWriter`).
  return (executor as unknown as typeof db).transaction(async (tx) => {
    const locked = await tx
      .select({ id: proposals.id, status: proposals.status })
      .from(proposals)
      .where(and(args.where, inArray(proposals.status, [...args.from])))
      // One lock order for every writer, so two bulk moves cannot deadlock.
      .orderBy(asc(proposals.id))
      .for("update", { of: proposals });
    if (locked.length === 0) return [];
    const rows = await tx
      .update(proposals)
      .set({ ...(args.set ?? {}), status: args.to })
      .where(
        inArray(
          proposals.id,
          locked.map((r) => r.id)
        )
      )
      .returning();
    const prior = new Map(locked.map((r) => [r.id, r.status]));
    const actor = args.actor ?? defaultActor(args.set);
    const transitions = rows
      .filter((row) => prior.get(row.id) !== args.to)
      .map((row) => proposalTransitionOf(row, prior.get(row.id)!, args, actor));
    await insertTransitionOutbox(tx, transitions);
    return rows;
  });
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

function proposalTransitionOf(
  row: ProposalRow,
  was: ProposalStatus,
  args: { to: ProposalStatus; reason?: string | null },
  actor: WorkUnitActor
): ProposalTransitionPayload {
  return {
    ...transitionBaseOf({
      subjectId: row.id,
      from: was,
      to: args.to,
      fromCategory: PROPOSAL_STATUS_DECLARATION[was].category,
      category: PROPOSAL_STATUS_DECLARATION[args.to].category,
      actor,
      // The person the proposal is for: who filed it, else whose principal
      // authored it, else its author (an agent's user row).
      ownerUserId:
        row.proposedByUserId ??
        row.subjectUserId ??
        row.createdBy ??
        row.agentUserId ??
        "system",
      sessionId: row.sessionId ?? null,
      // A refusal's or a failure's sentence is its reason; never a stale one.
      reason:
        args.reason ??
        (args.to === ProposalStatus.REJECTED ||
        args.to === ProposalStatus.APPROVAL_FAILED
          ? (row.rejectionReason ?? null)
          : null),
      proposalId: row.id,
      workspaceId: row.workspaceId ?? null,
      appId: row.appId ?? null,
    }),
    subjectType: "proposal",
    proposalType: row.proposalType,
    targetType: row.targetType,
    targetId: row.targetId,
    section: sectionOf(row),
  };
}

/**
 * A `document/*` patch proposal addresses a document section: the document
 * (its target) and the section ids its ops name. A proposed section joins the
 * door as its proposal (reactions W1).
 */
export function sectionOf(
  row: Pick<ProposalRow, "targetType" | "targetId" | "proposalType" | "data">
): ProposalSectionRef | null {
  if (
    row.targetType !== "document" ||
    !(DOCUMENT_PATCH_PROPOSAL_TYPES as readonly string[]).includes(
      row.proposalType
    )
  ) {
    return null;
  }
  const raw = (row.data ?? {}) as Record<string, unknown>;
  // The patch payload, wherever the filing door nested it.
  const payload = (
    raw.data && typeof raw.data === "object" && !Array.isArray(raw.ops)
      ? raw.data
      : raw
  ) as Record<string, unknown>;
  const ops = Array.isArray(payload.ops) ? payload.ops : [];
  const sectionIds = [
    ...new Set(
      ops.flatMap((op) => {
        const id = (op as { sectionId?: unknown } | null)?.sectionId;
        return typeof id === "string" && id.length > 0 ? [id] : [];
      })
    ),
  ];
  return { documentId: row.targetId, sectionIds };
}
