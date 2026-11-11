/**
 * PAST OUTCOMES as context for a one-shot run (plan 08e4fba7 §3.6, slice 8;
 * founder decision 8: "opt-in per playbook, last 3 approved and 3 rejected,
 * caption first").
 *
 * A one-shot playbook opts in on its landing (`lands.examples`); the run then
 * reads the drafts earlier runs of THIS playbook filed in THIS space FOR THIS
 * PERSON that the person has decided:
 *
 *  - approved: the text AS APPLIED. Approval applies the proposal's stored ops
 *    (`applyApprovedDocumentPatch` → `proposalOps`), and a revision before the
 *    approval rewrites those ops (`mergeProposalRevision`), so the stored
 *    section body IS what landed, the person's edits included. An edit made
 *    in the document after the approval is not seen.
 *  - rejected: the draft's text, with the person's reason when the reject door
 *    was given one (`proposals.rejection_reason`); an inline reject that sends
 *    no reason leaves it NULL and the example carries the text only.
 *
 * The join is the run's own record: `playbook_runs.generation.proposal.id`
 * names the proposal each run filed, so no proposal is attributed to a run by
 * guesswork. Only the person's own runs are read (`created_by`): their
 * decisions teach their drafts, and another member's records never reach this
 * person's prompt.
 *
 * A failed read THROWS: the run decides what a failure means (it proceeds
 * without examples and records the error), never this reader returning `[]`.
 */

import {
  and,
  desc,
  drizzleSql,
  eq,
  entities,
  getDb,
  isNull,
  playbookRuns,
  proposals,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { OutputLandingExamples } from "@synap/playbooks";
import { documentPatchPayload } from "../document-patch/document-edit-undo.js";

/** One decided draft of an earlier run, ready to show as an example. */
export interface PastOutcome {
  outcome: "approved" | "rejected";
  proposalId: string;
  runId: string;
  /** The record the earlier run drafted for (its title), when it still exists. */
  subjectTitle: string | null;
  /** The section text: as applied (approved) or as drafted (rejected). */
  text: string;
  /** The person's reason for a rejection, when one was given. */
  reason: string | null;
}

/** A decided draft that was read but has no section text to show. */
export interface PastOutcomeWithoutText {
  outcome: "approved" | "rejected";
  proposalId: string;
  runId: string;
}

/** The counts a landing asks for, each 0 when absent. */
export function examplesAsked(examples: OutputLandingExamples | undefined): {
  approved: number;
  rejected: number;
} {
  return {
    approved: Math.max(0, Math.trunc(examples?.approved ?? 0)),
    rejected: Math.max(0, Math.trunc(examples?.rejected ?? 0)),
  };
}

/**
 * The body of the section a patch proposal writes: the `upsert_section` op on
 * `sectionId` (the run's landing), else the patch's only `upsert_section`.
 * Null when the proposal carries no such text.
 */
export function proposedSectionBody(
  data: unknown,
  sectionId: string | undefined
): string | null {
  const ops = documentPatchPayload(data).ops;
  if (!Array.isArray(ops)) return null;
  const sections = ops.filter(
    (o): o is { op: string; id?: unknown; body: string } =>
      !!o &&
      typeof o === "object" &&
      (o as { op?: unknown }).op === "upsert_section" &&
      typeof (o as { body?: unknown }).body === "string"
  );
  const own =
    sections.find((o) => sectionId !== undefined && o.id === sectionId) ??
    (sections.length === 1 ? sections[0] : undefined);
  const text = own?.body.trim();
  return text ? text : null;
}

/**
 * The person's last `limit` drafts of this playbook in this space decided as
 * `outcome`, the most recently decided first.
 */
async function readDecided(input: {
  playbookId: string;
  workspaceId: string | null;
  userId: string;
  outcome: "approved" | "rejected";
  limit: number;
}): Promise<{ rows: PastOutcome[]; withoutText: PastOutcomeWithoutText[] }> {
  if (input.limit <= 0) return { rows: [], withoutText: [] };
  const db = await getDb();
  const status =
    input.outcome === "approved"
      ? ProposalStatus.APPROVED
      : ProposalStatus.REJECTED;
  const found = await db
    .select({
      runId: playbookRuns.id,
      generation: playbookRuns.generation,
      proposalId: proposals.id,
      data: proposals.data,
      reason: proposals.rejectionReason,
      subjectTitle: entities.title,
    })
    .from(playbookRuns)
    // The JSON side is cast, never the column, so each join reads the
    // primary key's index.
    .innerJoin(
      proposals,
      drizzleSql`${proposals.id} = (${playbookRuns.generation}->'proposal'->>'id')::uuid`
    )
    .leftJoin(
      entities,
      and(
        drizzleSql`${entities.id} = (${playbookRuns.generation}->>'subjectId')::uuid`,
        isNull(entities.deletedAt)
      )
    )
    .where(
      and(
        eq(playbookRuns.playbookId, input.playbookId),
        eq(playbookRuns.executor, "generate"),
        eq(playbookRuns.createdBy, input.userId),
        input.workspaceId === null
          ? isNull(playbookRuns.workspaceId)
          : eq(playbookRuns.workspaceId, input.workspaceId),
        eq(proposals.status, status)
      )
    )
    .orderBy(
      desc(
        drizzleSql`coalesce(${proposals.reviewedAt}, ${proposals.updatedAt})`
      )
    )
    .limit(input.limit);

  const rows: PastOutcome[] = [];
  const withoutText: PastOutcomeWithoutText[] = [];
  for (const r of found) {
    const text = proposedSectionBody(r.data, r.generation?.proposal?.sectionId);
    if (!text) {
      withoutText.push({
        outcome: input.outcome,
        proposalId: r.proposalId,
        runId: r.runId,
      });
      continue;
    }
    const reason =
      input.outcome === "rejected" ? r.reason?.trim() || null : null;
    rows.push({
      outcome: input.outcome,
      proposalId: r.proposalId,
      runId: r.runId,
      subjectTitle: r.subjectTitle ?? null,
      text,
      reason,
    });
  }
  return { rows, withoutText };
}

/**
 * The past outcomes a landing asks for: approved first, then rejected, each
 * most recently decided first. THROWS when the read fails.
 */
export async function readPastOutcomes(input: {
  playbookId: string;
  workspaceId: string | null;
  userId: string;
  asked: { approved: number; rejected: number };
}): Promise<{
  outcomes: PastOutcome[];
  withoutText: PastOutcomeWithoutText[];
}> {
  const base = {
    playbookId: input.playbookId,
    workspaceId: input.workspaceId,
    userId: input.userId,
  };
  const approved = await readDecided({
    ...base,
    outcome: "approved",
    limit: input.asked.approved,
  });
  const rejected = await readDecided({
    ...base,
    outcome: "rejected",
    limit: input.asked.rejected,
  });
  return {
    outcomes: [...approved.rows, ...rejected.rows],
    withoutText: [...approved.withoutText, ...rejected.withoutText],
  };
}
