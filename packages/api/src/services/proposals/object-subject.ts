/**
 * The proposals ABOUT an object, and THE proposal that CREATED it — one
 * derivation for `proposals.list({ subject })` (Lineage "Decided by") and
 * `outputs.landed` (the Landed row's decision).
 *
 * `targetId = <object id>` alone misses the proposal that CREATED the object
 * whenever governance filed that proposal under another target id:
 *
 *   - a COMPOSITE create ("Create 4 companies") is one proposal for many
 *     objects — its `target_id` names at most one of them;
 *   - the pending door keys `target_id` on `data.documentId || data.entityId ||
 *     data.id` (`permission-check.ts`), so an entity created WITH a body
 *     document is filed under the DOCUMENT's id.
 *
 * Both materializers stamp the object's `source_proposal_id`, and that stamp is
 * the join that recovers the approver (`create.ts`, "the JOIN that recovers the
 * APPROVER"). So:
 *
 *   ABOUT     = `target_id = id` OR `id = <source_proposal_id>`
 *   CREATING  = `source_proposal_id` when stamped; otherwise the EARLIEST
 *               APPLYING proposal (approved / auto_approved / reverted) on
 *               the target filed AT OR BEFORE the
 *               object's own creation (the auto-approve receipt is minted
 *               before the write; anything later is an edit, not the birth).
 *
 * The CREATING read is NOT floored: it answers "is there a creating proposal,
 * and can THIS viewer see it" (`visible`), because a hidden proposal must read
 * as an UNKNOWN decision — never as "applied" (`@synap-core/types/landed`).
 * Callers must not surface anything but `visible` from a row that is not.
 */

import {
  db,
  eq,
  inArray,
  or,
  entities,
  documents,
  proposals,
  drizzleSql,
} from "@synap/database";
import type { SQL } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import {
  PROPOSAL_SUBJECT_KINDS,
  type ProposalSubjectKind,
} from "@synap-core/types/landed";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

export { PROPOSAL_SUBJECT_KINDS, type ProposalSubjectKind };

/** Statuses under which a proposal's effect was applied (reverted = applied, then undone). */
const APPLYING_STATUSES = [
  ProposalStatus.APPROVED,
  ProposalStatus.AUTO_APPROVED,
  ProposalStatus.REVERTED,
] as const;

export async function proposalSubjectCondition(
  subject: { kind: ProposalSubjectKind; id: string },
  database: typeof db = db
): Promise<SQL> {
  const table = subject.kind === "entity" ? entities : documents;
  const [row] = await database
    .select({ sourceProposalId: table.sourceProposalId })
    .from(table)
    .where(eq(table.id, subject.id))
    .limit(1);
  const byTarget = eq(proposals.targetId, subject.id);
  return row?.sourceProposalId
    ? (or(byTarget, eq(proposals.id, row.sourceProposalId)) as SQL)
    : byTarget;
}

/** One object whose creating proposal is wanted. */
export interface CreatingProposalQuery {
  /** The object's id (`proposals.target_id` is text). */
  id: string;
  /** The object's own `source_proposal_id`, when stamped. */
  sourceProposalId: string | null;
  /** The object's creation instant — later proposals are edits. */
  bound: Date;
}

/** The creating proposal's facts. No `data`: nothing here needs the payload. */
export interface CreatingProposal {
  id: string;
  status: string;
  agentUserId: string | null;
  proposedByUserId: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  /** May THIS viewer see it (`userVisibleWhere`)? If not, read nothing else. */
  visible: boolean;
  /**
   * Objects the proposal created or changed — the undo's reach. Counted in SQL
   * from its materialized record (entities, documents, relations, facets,
   * property diffs); at least 1, the proposal's own target.
   */
  changeCount: number;
}

const materializedLength = (key: string) =>
  drizzleSql`(case when jsonb_typeof(${proposals.data}->'materialized'->${key}) = 'array' then jsonb_array_length(${proposals.data}->'materialized'->${key}) else 0 end)`;

/**
 * Objects a proposal created or changed — the undo's reach. Counted in SQL
 * from its materialized record; at least 1, the proposal's own target. Shared
 * with `activity.list`'s Undo door.
 */
export const proposalChangeCountSql = () =>
  drizzleSql<number>`greatest(1, ${materializedLength("entityIds")} + ${materializedLength("documentIds")} + ${materializedLength("relationIds")} + ${materializedLength("facetIds")} + ${materializedLength("propertyDiffs")})::int`;

function creatingColumns(viewer: string) {
  return {
    id: proposals.id,
    status: proposals.status,
    agentUserId: proposals.agentUserId,
    proposedByUserId: proposals.proposedByUserId,
    reviewedBy: proposals.reviewedBy,
    reviewedAt: proposals.reviewedAt,
    createdAt: proposals.createdAt,
    visible: drizzleSql<boolean>`(${userVisibleWhere(proposals.workspaceId, viewer)})`,
    changeCount: proposalChangeCountSql(),
  };
}

/**
 * THE creating proposal per object, batched: one read for the stamped ids,
 * one `DISTINCT ON (target_id)` read for the rest — the earliest APPLYING
 * proposal at or before each object's own bound. Keyed by object id.
 */
export async function findCreatingProposals(
  database: typeof db,
  objects: readonly CreatingProposalQuery[],
  viewer: string
): Promise<Map<string, CreatingProposal>> {
  const out = new Map<string, CreatingProposal>();
  if (objects.length === 0) return out;
  const cols = creatingColumns(viewer);

  const stamped = objects.filter((o) => o.sourceProposalId);
  const unstamped = objects.filter((o) => !o.sourceProposalId);

  const [bySource, byTarget] = await Promise.all([
    stamped.length
      ? database
          .select(cols)
          .from(proposals)
          .where(
            inArray(
              proposals.id,
              stamped.map((o) => o.sourceProposalId!)
            )
          )
      : Promise.resolve([]),
    unstamped.length
      ? database
          .selectDistinctOn([proposals.targetId], {
            ...cols,
            targetId: proposals.targetId,
          })
          .from(proposals)
          .innerJoin(
            drizzleSql`(values ${drizzleSql.join(
              unstamped.map(
                (o) =>
                  drizzleSql`(${o.id}::text, ${o.bound.toISOString()}::timestamptz)`
              ),
              drizzleSql`, `
            )}) as b(id, bound)`,
            drizzleSql`${proposals.targetId} = b.id and ${proposals.createdAt} <= b.bound`
          )
          // Only a proposal that APPLIED something can have created the object:
          // a rejected / withdrawn / expired first attempt before a retry is
          // not its birth, and neither is a pending one.
          .where(inArray(proposals.status, [...APPLYING_STATUSES]))
          .orderBy(proposals.targetId, proposals.createdAt, proposals.id)
      : Promise.resolve([]),
  ]);

  const sourceById = new Map(bySource.map((p) => [p.id, p]));
  for (const o of stamped) {
    const p = sourceById.get(o.sourceProposalId!);
    if (p) out.set(o.id, normalize(p));
  }
  for (const p of byTarget) out.set(p.targetId, normalize(p));
  return out;
}

function normalize(p: {
  id: string;
  status: string;
  agentUserId: string | null;
  proposedByUserId: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | string | null;
  createdAt: Date | string;
  visible: boolean;
  changeCount: number;
}): CreatingProposal {
  return {
    id: p.id,
    status: p.status,
    agentUserId: p.agentUserId,
    proposedByUserId: p.proposedByUserId,
    reviewedBy: p.reviewedBy,
    reviewedAt: p.reviewedAt ? new Date(p.reviewedAt) : null,
    createdAt: new Date(p.createdAt),
    visible: p.visible === true || (p.visible as unknown) === "t",
    changeCount: Number(p.changeCount),
  };
}

/**
 * The single-object form, for `proposals.list({ subject })`: the object's
 * creating proposal id, or `null` when the object has none (or does not
 * exist). Same derivation as the batch — it IS the batch, with one member.
 */
export async function findCreatingProposalId(
  database: typeof db,
  subject: { kind: ProposalSubjectKind; id: string },
  viewer: string
): Promise<string | null> {
  const table = subject.kind === "entity" ? entities : documents;
  const [row] = await database
    .select({
      sourceProposalId: table.sourceProposalId,
      createdAt: table.createdAt,
    })
    .from(table)
    .where(eq(table.id, subject.id))
    .limit(1);
  if (!row) return null;
  const found = await findCreatingProposals(
    database,
    [
      {
        id: subject.id,
        sourceProposalId: row.sourceProposalId,
        bound: new Date(row.createdAt),
      },
    ],
    viewer
  );
  return found.get(subject.id)?.id ?? null;
}
