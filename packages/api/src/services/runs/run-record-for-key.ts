/**
 * GET /runs/:id for a key that does not read a run's whole detail
 * (`runDetailReadable` is false: an app, whose grant is pinned to its spaces).
 *
 * Such a key gets a ONE-SHOT run's record (`playbook_runs.generation`: the
 * prompt it sent, what the prompt was made of, the model, tokens and cost of
 * its one call, the proposal it filed), because the app that ran the action
 * shows "how this was made" beside the proposal (plan 08e4fba7 §3.5). Both
 * reads carry the key's grant:
 *   - the run row through `scopedDb(...).predicate(playbookRuns)` (subject
 *     `playbook`, the person's floor AND the grant);
 *   - the run's SUBJECT through the entity read floor (`accessScopeWhere`,
 *     the grant ANDed): the prompt quotes the subject's fields and its
 *     document, so a run about a thing the grant does not reach is not found.
 * The record is its CREATOR's (`playbook_runs.created_by` = the key's
 * person): another member's run in the same space reads as no record.
 * Everything else (a session run's turns, room, records, proposals) is said
 * withheld, never an empty list.
 */

import { and, db, entities, eq, isNull, playbookRuns } from "@synap/database";
import type { PlaybookRunGeneration } from "@synap/database/schema";
import { scopedDb } from "../../access/scoped-db.js";
import { AccessContext } from "../../access/context.js";
import { accessScopeWhere } from "../../utils/project-scope.js";

/** What a key that does not read the whole detail gets for one run. */
export interface RunRecordForKey {
  run: {
    id: string;
    flowType: "playbook";
    playbookId: string;
    status: string;
    executor: string;
    startedAt: Date;
    completedAt: Date | null;
  };
  /** The detail's own field names: the record lives at `playbookDetail.generation`. */
  playbookDetail: { generation: PlaybookRunGeneration | null };
  detail: { status: "withheld"; reason: string };
}

const WITHHELD_REASON =
  "This key does not read everything a run's detail holds (its session, room, records and proposals): only a one-shot run's record is shown.";

/**
 * The run as this key may read it; `null` = not found for it (no such run,
 * not the person's, outside the grant, or about a subject the grant does not
 * reach).
 */
export async function readRunRecordForKey(input: {
  userId: string;
  runId: string;
}): Promise<RunRecordForKey | null> {
  const access = AccessContext.agent({ userId: input.userId });
  const [run] = await db
    .select({
      id: playbookRuns.id,
      playbookId: playbookRuns.playbookId,
      status: playbookRuns.status,
      executor: playbookRuns.executor,
      startedAt: playbookRuns.startedAt,
      completedAt: playbookRuns.completedAt,
      sessionId: playbookRuns.sessionId,
      createdBy: playbookRuns.createdBy,
      generation: playbookRuns.generation,
    })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.id, input.runId),
        scopedDb(access).predicate(playbookRuns)
      )
    )
    .limit(1);
  if (!run) return null;

  // A one-shot run's record quotes its subject and the person's past drafts:
  // it is its CREATOR's alone (another member's run reads as no record), and
  // readable only when the grant reaches that subject. A session run has no
  // such record here.
  const generation =
    !run.sessionId && run.createdBy === input.userId
      ? (run.generation ?? null)
      : null;
  if (generation?.subjectId) {
    const [subject] = await db
      .select({ id: entities.id })
      .from(entities)
      .where(
        and(
          eq(entities.id, generation.subjectId),
          isNull(entities.deletedAt),
          accessScopeWhere({
            workspaceIdColumn: entities.workspaceId,
            entityIdColumn: entities.id,
            ownerColumn: entities.userId,
            userId: input.userId,
            facetLens: true,
          })
        )
      )
      .limit(1);
    if (!subject) return null;
  } else if (generation) {
    // A record with no subject names nothing the grant can bound: withheld.
    return null;
  }

  return {
    run: {
      id: run.id,
      flowType: "playbook",
      playbookId: run.playbookId,
      status: run.status,
      executor: run.executor,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? null,
    },
    playbookDetail: { generation },
    detail: { status: "withheld", reason: WITHHELD_REASON },
  };
}
