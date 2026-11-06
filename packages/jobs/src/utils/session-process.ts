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
 *
 * ONE RESOLUTION of the status property (finding bfae3b84): a process that
 * names no `statusProperty` follows the lifecycle its subject kind (or role)
 * DECLARES — what `synap_create_playbook` tells agents to do ("omit
 * statusProperty: the process follows the lifecycle the kind declares"). It is
 * resolved HERE, where every runtime reader loads the process (the stage
 * write, the subject-first advance, the close door's end moves, the reverse
 * follow in `process-sync.ts`), never per caller. A named `statusProperty`
 * keeps winning; a kind with no declared lifecycle stays `null` (each reader
 * reports its skip). The declaration is read live (a kind that declares its
 * lifecycle later is followed from then on), through `readSubjectProfile`,
 * the one reader the activators use too.
 */

import {
  db,
  focusSessions,
  playbooks,
  playbookRuns,
  eq,
  and,
  desc,
  liveRunStatusWhere,
} from "@synap/database";
import {
  readSubjectLifecycle,
  type PlaybookOnEnd,
  type PlaybookStage,
} from "@synap/playbooks";
import { readSubjectProfile } from "./subject-profile.js";

export interface SessionProcess {
  stages: PlaybookStage[];
  /**
   * The subject profile the process runs on — a KIND or a ROLE. A role's
   * status lives on its facet, so the forward write must name it.
   */
  profileSlug: string | null;
  /**
   * The subject's property the process moves: the one it names, else the
   * property its subject profile DECLARES as its lifecycle (header); null
   * when neither.
   */
  statusProperty: string | null;
  humanOnlyStatuses: string[];
  /**
   * What each session END moves the subject (and every target still open)
   * to — `subjectProfile.onEnd`, frozen with the rest of the process. Read by
   * the one close door BEFORE it settles the run, so it is the snapshot's.
   */
  onEnd: PlaybookOnEnd;
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
  const lifecycle = readSubjectLifecycle(subjectProfile);
  const { profileSlug, humanOnlyStatuses, onEnd } = lifecycle;
  let statusProperty = lifecycle.statusProperty;
  if (!statusProperty && profileSlug) {
    // The process names none: it follows the lifecycle the profile declares,
    // as the session's space sees that slug (header).
    const [session] = await db
      .select({ workspaceId: focusSessions.workspaceId })
      .from(focusSessions)
      .where(eq(focusSessions.id, input.sessionId))
      .limit(1);
    statusProperty = (
      await readSubjectProfile(profileSlug, session?.workspaceId ?? null)
    ).lifecycleProperty;
  }
  return { stages, profileSlug, statusProperty, humanOnlyStatuses, onEnd };
}
