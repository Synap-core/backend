/**
 * WHAT A PLAYBOOK RUN IS ABOUT — the ONE reading. A session run's subject is
 * its session's (`focus_sessions.subject_entity_id`); a ONE-SHOT run has no
 * session, and its record names it (`playbook_runs.generation.subjectId`).
 *
 * The record is its CREATOR's (it quotes the subject's document and the
 * person's past drafts and reject reasons; decision D1 for a session, the
 * review of the lean-runs wave for a one-shot run): read for a VIEWER, a
 * one-shot run's subject counts only when the viewer created the run, so a
 * subject lens is no oracle for what a colleague drafted about. `viewerId:
 * null` is a SYSTEM read (a guardrail of the run door), never a person's.
 */

import {
  and,
  drizzleSql,
  eq,
  focusSessions,
  isNull,
  or,
  playbookRuns,
} from "@synap/database";
import type { SQL } from "drizzle-orm";

/** A one-shot run (no session) whose record names `subjectId`. */
export function oneShotRunSubjectIs(
  subjectId: string,
  viewerId: string | null
): SQL {
  return and(
    isNull(playbookRuns.sessionId),
    viewerId === null ? undefined : eq(playbookRuns.createdBy, viewerId),
    drizzleSql`${playbookRuns.generation}->>'subjectId' = ${subjectId}`
  )!;
}

/** The run is about `subjectId`. Needs `focus_sessions` (left) joined on the run. */
export function runSubjectMatches(
  subjectId: string,
  viewerId: string | null
): SQL {
  return or(
    eq(focusSessions.subjectEntityId, subjectId),
    oneShotRunSubjectIs(subjectId, viewerId)
  )!;
}

/** The run's subject as a column, for `viewerId`. Needs `focus_sessions` (left) joined. */
export function runSubjectColumn(viewerId: string): SQL<string | null> {
  return drizzleSql<
    string | null
  >`coalesce(${focusSessions.subjectEntityId}::text, case when ${playbookRuns.sessionId} is null and ${playbookRuns.createdBy} = ${viewerId} then ${playbookRuns.generation}->>'subjectId' end)`;
}
