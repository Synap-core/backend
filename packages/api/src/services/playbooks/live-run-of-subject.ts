/**
 * ONE LIVE RUN PER OBJECT (founder, 2026-11-16, plan ec581c1d) — the read the
 * run door asks before it starts a person's run: is a run of this playbook
 * already LIVE on this object, for this person?
 *
 * Founder decisions, final:
 *   1. a second manual run of the same playbook on the same object is not
 *      started while one is live; the person may still "start another";
 *   2. regardless of params: the key is (playbook, object), never a params hash;
 *   3. an agent's draft waiting for the person's acceptance counts as live;
 *   4. ending the run (the existing cancel/close doors) frees the object.
 *
 * The key also carries the OWNER: a pod-wide playbook run by two people on one
 * object gives each their own run, and this read never returns another
 * person's private session. Live = {@link LIVE_RUN_SESSION_STATUSES}
 * (@synap-core/types), the set the partial unique index lists (0427).
 *
 * Counted: every live run of the playbook on the object that the person owns
 * — a slot-holder (`one_live_per_subject`), an earlier "start another", a run
 * an automation started for them, a run from before 0427. NOT counted: a run
 * that works a STEP of another run (`metadata.stageOf`: a forEach batch or a
 * hand-off child; its parent is the run) and a TRIAL (the rule lab writes
 * nothing and must not hold the object).
 *
 * The read is advisory; the index is the floor. Two clicks that both read
 * "nothing live" race to the insert, and the loser's unique violation is
 * answered with this same read (`run-playbook.ts`).
 *
 * SESSION-KIND-LENS-EXEMPT: reads ONE session (limit 1) for the run door's already_running answer, never a page of sessions; its draft state is said by `reason`.
 */
import {
  getDb,
  and,
  desc,
  eq,
  inArray,
  drizzleSql,
  focusSessions,
  playbookRuns,
} from "@synap/database";
import type { FocusSession, PlaybookRun } from "@synap/database/schema";
import { LIVE_RUN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import { HELD_RUN_META_KEY } from "../focus-sessions/session-metadata.js";
import { STAGE_OF_METADATA_KEY } from "./stage-of.js";

/**
 * Why nothing new started. `live_run`: a run is live on the object (running,
 * paused, or gone quiet). `draft_awaiting_acceptance`: an agent's run of it
 * waits for the person to accept it (decision 3), so it has not started yet.
 */
export type AlreadyRunningReason = "live_run" | "draft_awaiting_acceptance";

export interface LiveRunOfSubject {
  /** The live session: the run the person opens. */
  session: FocusSession;
  /** Its newest ledger row, or null (a held draft has none yet). */
  run: PlaybookRun | null;
  reason: AlreadyRunningReason;
}

/**
 * The person's live run of `playbookId` on `subjectId`, or null. The run that
 * holds the slot comes first; among several live runs (an earlier "start
 * another", runs from before 0427), the newest.
 */
export async function findLiveRunOfSubject(input: {
  playbookId: string;
  subjectId: string;
  userId: string;
}): Promise<LiveRunOfSubject | null> {
  const db = await getDb();
  const [session] = await db
    .select()
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.playbookId, input.playbookId),
        eq(focusSessions.subjectEntityId, input.subjectId),
        eq(focusSessions.userId, input.userId),
        inArray(focusSessions.status, [...LIVE_RUN_SESSION_STATUSES]),
        drizzleSql`NOT (coalesce(${focusSessions.metadata}, '{}'::jsonb) ? ${STAGE_OF_METADATA_KEY})`,
        drizzleSql`NOT (coalesce(${focusSessions.metadata}, '{}'::jsonb) ? 'trial')`
      )
    )
    .orderBy(
      desc(focusSessions.oneLivePerSubject),
      desc(focusSessions.startedAt)
    )
    .limit(1);
  if (!session) return null;
  const [run] = await db
    .select()
    .from(playbookRuns)
    .where(eq(playbookRuns.sessionId, session.id))
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  return {
    session: session as FocusSession,
    run: (run as PlaybookRun | undefined) ?? null,
    reason:
      metadata[HELD_RUN_META_KEY] != null
        ? "draft_awaiting_acceptance"
        : "live_run",
  };
}

/** The run door's sentence for an `already_running` answer. */
export function alreadyRunningMessage(
  playbookName: string,
  reason: AlreadyRunningReason
): string {
  return reason === "draft_awaiting_acceptance"
    ? `"${playbookName}" already waits for you to accept it on this record, so another run was not started. Open it to accept it, or pass startAnother to start a second run.`
    : `"${playbookName}" is already running on this record, so another run was not started. Open that run, end it to free the record, or pass startAnother to start a second run.`;
}
