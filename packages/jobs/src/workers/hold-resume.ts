/**
 * HOLD RESUME (status-flow plan W4) — a paused thing goes back to the status
 * it left when what it waited on is over:
 *
 *   - `until.date`: the hourly sweep (this queue with no data) resumes every
 *     current hold whose date has come;
 *   - `until.moves`: the reactor below sends this queue the transition of
 *     every move; the job resumes the holds that waited on that thing (and,
 *     with `until.to`, on it reaching that status or category).
 *
 * A passed `reviewBy` is NOT a move: it is a signal the watcher reads
 * (`CurrentHold.reviewDue`). The holds are read with the one helper
 * (`listHolds`, @synap/database); each resume is the SYSTEM's move through
 * the subject's own write — `applyStatusMove` for an entity, the goal's
 * `TrackRepository.transitionStatus`, `setSessionStatus` for a session — a
 * compare-and-set from the paused status, so a thing someone moved meanwhile
 * is left as it is. The resume executes a decision already made (the pause
 * and its `until` went through governance when they were filed), so it is
 * not governed again, like an approval replay.
 */
import {
  EventRepository,
  TrackRepository,
  applyStatusMove,
  db,
  listHolds,
  resolveStatusMoveTarget,
  setSessionStatus,
  sql,
  type CurrentHold,
} from "@synap/database";
import {
  dispatchLifecycleTransition,
  emitSideEffects,
  registerReactor,
  type Reactor,
} from "@synap/events";
import { createLogger } from "@synap-core/core";
import { CHECK_GATE_METADATA_KEY } from "@synap-core/types/focus-sessions";
import type { SessionStatus } from "@synap-core/types/focus-sessions";
import { holdWokenBy } from "@synap-core/types/lifecycle";
import type { ProjectTrackStatus } from "@synap/database/schema";

const logger = createLogger({ module: "hold-resume" });

export const HOLD_RESUME_QUEUE = "hold-resume";
/** Hourly: a hold whose date has come resumes within the hour. */
export const HOLD_RESUME_CRON = "23 * * * *";

/** What moved, when the job was sent by the reactor (absent: the date sweep). */
export interface HoldResumeJobData {
  awaiting?: {
    subjectType: string;
    subjectId: string;
    to: string;
    category: string;
  };
}

export async function handleHoldResume(
  data: HoldResumeJobData = {},
  now: Date = new Date()
): Promise<{ resumed: number; skipped: number }> {
  const moved = data.awaiting;
  const held = moved
    ? (await listHolds(db, { awaiting: moved }, now)).filter((h) =>
        holdWokenBy(h.hold.until, moved)
      )
    : await listHolds(db, { resumeDueBy: now }, now);
  let resumed = 0;
  let failure: unknown = null;
  for (const h of held) {
    const reason = moved
      ? `What it waited on (${moved.subjectType}:${moved.subjectId}) moved to ${moved.to}.`
      : `Its hold ran until ${(h.hold.until as { date: string }).date}.`;
    try {
      if (await resumeHold(h, reason)) resumed++;
    } catch (err) {
      failure = err;
      logger.warn(
        { err, subjectType: h.subjectType, subjectId: h.subjectId },
        moved
          ? "hold resume failed — the job is retried"
          : "hold resume failed — retried on the next tick"
      );
    }
  }
  // A move happens once: a failed wake is retried by pg-boss (what already
  // resumed is no longer held, so a retry never moves it twice). The date
  // sweep needs no retry: the next hourly tick finds the hold still due.
  if (moved && failure) throw failure;
  if (held.length > 0) {
    logger.info(
      { resumed, skipped: held.length - resumed, by: moved ? "move" : "date" },
      "Resumed held things"
    );
  }
  return { resumed, skipped: held.length - resumed };
}

/** Move one held thing back to the status its pause began from; false when it did not move. */
async function resumeHold(h: CurrentHold, reason: string): Promise<boolean> {
  const to = h.hold.resumeTo;
  // A pause recorded before anyone knew where it came from has nowhere to go.
  if (!to) return false;
  switch (h.subjectType) {
    case "entity": {
      const resolved = await resolveStatusMoveTarget(db, {
        entityId: h.subjectId,
        facetId: h.facetId,
        workspaceId: h.workspaceId,
      });
      if (!resolved.ok) return false;
      const result = await applyStatusMove(db, {
        target: resolved.target,
        expectedFrom: h.status,
        to,
        actor: { kind: "system", userId: h.userId },
        strict: true,
        reason,
        lensWorkspaceId: h.workspaceId,
      });
      if (result.status !== "moved") return false;
      await dispatchLifecycleTransition(result.transition.transitionId);
      return true;
    }
    case "track": {
      const row = await new TrackRepository(
        db,
        new EventRepository(sql)
      ).transitionStatus(
        h.subjectId,
        {
          from: h.status as ProjectTrackStatus,
          to: to as ProjectTrackStatus,
          // A resumed goal is held by nothing (as `applyTrackStatus`).
          dropMetadataKey: CHECK_GATE_METADATA_KEY,
          actor: { kind: "system" },
          reason,
        },
        h.userId
      );
      if (!row) return false;
      await followUp(h, to);
      // The goal loop reads a goal's status moves off this event.
      void emitSideEffects({
        subjectType: "track",
        action: "update",
        subjectId: row.id,
        userId: h.userId,
        workspaceId: h.workspaceId,
        data: {
          trackId: row.id,
          projectId: row.projectId,
          fromStatus: h.status,
          toStatus: to,
        },
      }).catch((err) =>
        logger.warn({ err, trackId: row.id }, "track.update emit failed")
      );
      return true;
    }
    case "focus_session": {
      const { rows, transitions } = await setSessionStatus(db, {
        sessionId: h.subjectId,
        from: h.status as SessionStatus,
        to: to as SessionStatus,
        actor: { kind: "system" },
        reason,
        // Resuming is activity: the idle clock starts again.
        set: { updatedAt: new Date() },
      });
      for (const t of transitions) {
        await dispatchLifecycleTransition(t.transitionId);
      }
      if (rows.length > 0) await followUp(h, to);
      return rows.length > 0;
    }
  }
}

/**
 * What the api's own doors do after the same move (a goal's judgement
 * notices, `refreshGoalJudgements`; a stale session's runs back to running,
 * as `reviveStaleSession`). `@synap/api` depends on `@synap/jobs`, so it fills
 * this slot at boot (apps/api), the pattern of `registerSessionCloser`.
 */
export type HoldResumeFollowUp = (resumed: {
  subjectType: CurrentHold["subjectType"];
  subjectId: string;
  userId: string;
  from: string;
  to: string;
}) => Promise<void>;

let holdResumeFollowUp: HoldResumeFollowUp | null = null;

export function registerHoldResumeFollowUp(fn: HoldResumeFollowUp): void {
  holdResumeFollowUp = fn;
}

async function followUp(h: CurrentHold, to: string): Promise<void> {
  if (!holdResumeFollowUp) {
    logger.warn(
      { subjectType: h.subjectType, subjectId: h.subjectId },
      "hold resume follow-up not registered — apps/api must call registerHoldResumeFollowUp() at boot"
    );
    return;
  }
  await holdResumeFollowUp({
    subjectType: h.subjectType,
    subjectId: h.subjectId,
    userId: h.userId,
    from: h.status,
    to,
  });
}

/**
 * Every transition is a move a hold may be waiting on: sent to the queue
 * (off the emit path), where the job reads the holds that wait on it.
 */
export const holdResumeReactor: Reactor = {
  id: "hold-resume",
  match: (payload) => payload.action === "transition",
  async handler(payload, { boss }) {
    const d = payload.data ?? {};
    if (typeof d.to !== "string" || typeof d.category !== "string") return;
    await boss.send(
      HOLD_RESUME_QUEUE,
      {
        awaiting: {
          subjectType: payload.subjectType,
          subjectId: payload.subjectId,
          to: d.to,
          category: d.category,
        },
      } satisfies HoldResumeJobData,
      // A redelivered transition is one wake, not two.
      payload.eventId ? { singletonKey: `hold-resume:${payload.eventId}` } : {}
    );
  },
};

let registered = false;

/** Register the reactor; called once where the workers register. */
export function registerHoldResumeReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(holdResumeReactor);
}
