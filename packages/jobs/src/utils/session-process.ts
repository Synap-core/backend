/**
 * The PROCESS view of a focus session's definition — its stages plus the
 * subject lifecycle contract (`subjectProfile.statusProperty`,
 * `humanOnlyStatuses`). ONE reader, here in @synap/jobs because both halves of
 * the stage ↔ subject-status loop need it: @synap/api (the forward write on an
 * advance, `services/focus-sessions/stage-subject-status.ts`, imports it as
 * `@synap/jobs/utils/session-process.js`) and this package (the reverse
 * follow, `process-sync.ts`). jobs cannot import api; api can import jobs.
 *
 * Source precedence: the RUN's frozen `definitionSnapshot` first (a run
 * executes the definition it started with), the live playbook second — the
 * precedence `resolveStageGateForSession` uses. The lifecycle contract
 * (`subjectProfile`) is read the same way: the snapshot's when the run froze
 * one (`buildDefinitionSnapshot`), the live playbook's for an older run that
 * did not.
 */

import {
  db,
  playbooks,
  playbookRuns,
  eq,
  and,
  desc,
  liveRunStatusWhere,
} from "@synap/database";
import { readSubjectLifecycle, type PlaybookStage } from "@synap/playbooks";

export interface SessionProcess {
  stages: PlaybookStage[];
  statusProperty: string | null;
  humanOnlyStatuses: string[];
}

export async function loadSessionProcess(input: {
  sessionId: string;
  playbookId: string | null;
}): Promise<SessionProcess | null> {
  const [run] = await db
    .select({ definitionSnapshot: playbookRuns.definitionSnapshot })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, input.sessionId),
        liveRunStatusWhere(playbookRuns.status)
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  const snap = (run?.definitionSnapshot ?? null) as {
    stages?: unknown;
    subjectProfile?: unknown;
  } | null;
  let stages = Array.isArray(snap?.stages)
    ? (snap!.stages as PlaybookStage[])
    : null;
  let subjectProfile: unknown = snap?.subjectProfile;
  if ((!stages || subjectProfile === undefined) && input.playbookId) {
    const [pb] = await db
      .select({
        stages: playbooks.stages,
        subjectProfile: playbooks.subjectProfile,
      })
      .from(playbooks)
      .where(eq(playbooks.id, input.playbookId))
      .limit(1);
    if (pb) {
      stages ??= Array.isArray(pb.stages) ? (pb.stages as PlaybookStage[]) : [];
      if (subjectProfile === undefined) subjectProfile = pb.subjectProfile;
    }
  }
  if (!stages) return null;
  const { statusProperty, humanOnlyStatuses } =
    readSubjectLifecycle(subjectProfile);
  return { stages, statusProperty, humanOnlyStatuses };
}
