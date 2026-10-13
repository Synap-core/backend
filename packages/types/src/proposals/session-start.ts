/**
 * A proposal that STARTS a session from a playbook — what approving a
 * `run` on a playbook creates (`executors/playbook.ts` → `playbooks.run` →
 * `instantiateSessionRow`): one focus session per subject.
 *
 * ONE classification, read by the pod's display (title) and by every
 * renderer (browser, relay) through the shared presentation, so a rule's
 * "run this playbook" ask can never read as "Run Template" in one place and
 * "Start session" in another. Pure.
 */

/** True when the proposal starts a session from a playbook (single or batch). */
export function isPlaybookSessionStartProposal(row: {
  targetType?: string | null;
  proposalType?: string | null;
}): boolean {
  return row.targetType === "playbook" && row.proposalType === "run";
}

/**
 * A run proposal's subjects: `subjectIds` (a batch) or the one `subjectId`.
 * The ONE reader — the approval executor fans out over exactly this list, and
 * the review names exactly these.
 */
export function readRunSubjectIds(
  payload: Record<string, unknown> | null | undefined
): string[] {
  if (!payload) return [];
  if (Array.isArray(payload.subjectIds)) {
    return payload.subjectIds.filter(
      (v): v is string => typeof v === "string" && v.length > 0
    );
  }
  return typeof payload.subjectId === "string" && payload.subjectId
    ? [payload.subjectId]
    : [];
}
