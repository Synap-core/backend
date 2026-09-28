/**
 * "Every proposal ABOUT this object" — the `proposals.list({ subject })` filter
 * behind an entity / document's Lineage "Decided by".
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
 * APPROVER"). So the subject is: `target_id = id` OR `id = <source_proposal_id>`.
 *
 * Adds no reach: the caller's proposal visibility conditions still apply to
 * every row; reading the object's own `source_proposal_id` names at most one
 * proposal id, which is then filtered like any other.
 */

import { db, eq, or, entities, documents, proposals } from "@synap/database";
import type { SQL } from "@synap/database";

export const PROPOSAL_SUBJECT_KINDS = ["entity", "document"] as const;
export type ProposalSubjectKind = (typeof PROPOSAL_SUBJECT_KINDS)[number];

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
