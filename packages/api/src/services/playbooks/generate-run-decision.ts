/**
 * A ONE-SHOT run follows its draft's decision (cross-repo review, watch 10).
 * A one-shot run files ONE proposal and settles as `proposed`; when the person
 * decides it, the run row moves with it, so a feed never shows "proposed" for
 * a draft that was approved or discarded long ago:
 *   - approved → `completed`;
 *   - rejected or withdrawn → `cancelled` (the run vocabulary's "stopped":
 *     the draft was discarded, nothing failed);
 *   - reopened (rejected → pending again) → back to `proposed`.
 * Compare-and-set on the status it moves FROM, so a run that already moved
 * (or failed) is never overwritten. The run is found by the stamp its
 * proposal carries (`data.run.id`, `applyDocumentPatch` input `run`), else by
 * the proposal id its record holds (a draft filed before the stamp).
 */

import {
  and,
  db,
  drizzleSql,
  eq,
  inArray,
  playbookRuns,
  proposals,
} from "@synap/database";
import type { PlaybookRunStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { documentPatchPayload } from "../document-patch/document-edit-undo.js";

const logger = createLogger({ module: "generate-run-decision" });

export type ProposalDecision =
  "approved" | "rejected" | "reopened" | "withdrawn";

const MOVES: Record<
  ProposalDecision,
  { from: PlaybookRunStatus[]; to: PlaybookRunStatus; terminal: boolean }
> = {
  approved: { from: ["proposed"], to: "completed", terminal: true },
  rejected: { from: ["proposed"], to: "cancelled", terminal: true },
  withdrawn: { from: ["proposed"], to: "cancelled", terminal: true },
  reopened: { from: ["cancelled"], to: "proposed", terminal: false },
};

/** The run that filed this proposal, or null when no one-shot run did. */
async function runOfProposal(proposalId: string): Promise<string | null> {
  const [p] = await db
    .select({ data: proposals.data })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1);
  if (!p) return null;
  const stamp = documentPatchPayload(p.data).run as
    { id?: unknown } | undefined;
  if (typeof stamp?.id === "string") return stamp.id;
  const [byRecord] = await db
    .select({ id: playbookRuns.id })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.executor, "generate"),
        drizzleSql`${playbookRuns.generation}->'proposal'->>'id' = ${proposalId}`
      )
    )
    .limit(1);
  return byRecord?.id ?? null;
}

/**
 * Move the one-shot run of `proposalId` with its decision. Returns the run's
 * new status, or null when nothing moved (no one-shot run, or it had already
 * moved). Never throws into the decision that called it: a failure is logged.
 */
export async function settleGenerateRunOnDecision(
  proposalId: string,
  decision: ProposalDecision
): Promise<PlaybookRunStatus | null> {
  try {
    const runId = await runOfProposal(proposalId);
    if (!runId) return null;
    const move = MOVES[decision];
    const [moved] = await db
      .update(playbookRuns)
      .set({
        status: move.to,
        completedAt: move.terminal ? new Date() : null,
      })
      .where(
        and(
          eq(playbookRuns.id, runId),
          eq(playbookRuns.executor, "generate"),
          inArray(playbookRuns.status, move.from)
        )
      )
      .returning({ status: playbookRuns.status });
    return moved?.status ?? null;
  } catch (err) {
    logger.warn(
      { err, proposalId, decision },
      "settling a one-shot run on its draft's decision failed"
    );
    return null;
  }
}
