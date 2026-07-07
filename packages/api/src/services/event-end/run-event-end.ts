/**
 * Event End — flip event-mode focus sessions into their `post` stage.
 *
 * The autonomous counterpart of `run-event-sync`. On a 5-minute cron the jobs
 * `event-end-cron` worker invokes this in-process via the `registerEventEndRunner`
 * IoC slot (jobs can't import @synap/api).
 *
 * UNIFIED "event mode": event mode is not a separate channel — it time-boxes the
 * existing capture channel to an event via a focus session whose
 * `subjectEntityId` is the event entity. Captures during the window auto-link to
 * the event through the `session --produced--> entity` edge. When the event's
 * `endDate` crosses `now`, THIS runner advances that session to the `post` stage:
 *   updateFocusSession({ currentStage: 'post' })  →  emits
 *   `focus_session.stage_changed.post`  →  the session-recap reactor
 *   (@synap/events side-effects) enqueues the `session-recap` worker.
 *
 * We flip the stage as the SESSION OWNER (no agentUserId) so it auto-applies —
 * the stage flip is a system mechanic, not an agent write; governance lives on
 * the recap's follow-up proposal, not here.
 *
 * Idempotency is migration-free: a `systemData.eventEndFired` boolean stamp on
 * the event entity (jsonb_set), mirroring event-sync's watermark technique. An
 * already-fired event is filtered out of the query, so this stays cheap after the
 * first pass and never re-fires a recap.
 */

import {
  db,
  entities,
  focusSessions,
  eq,
  and,
  drizzleSql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { updateFocusSession } from "../focus-sessions/update-session.js";

const logger = createLogger({ module: "event-end" });

/**
 * Only consider events whose endDate crossed within this look-back window. The
 * `eventEndFired` stamp already makes the query cheap after the first pass; this
 * bound keeps the FIRST pass (on a pod with historical events) from scanning an
 * unbounded backlog and only recaps freshly-ended events (a still-open session
 * for an event that ended long ago is a stale-session edge case).
 */
const LOOKBACK_DAYS = 7;

export interface RunEventEndResult {
  scanned: number;
  flipped: number;
  stamped: number;
}

/** Stamp `systemData.eventEndFired = true` on the event (atomic single-leaf). */
async function stampFired(eventId: string): Promise<void> {
  await db
    .update(entities)
    .set({
      systemData: drizzleSql`jsonb_set(COALESCE(${entities.systemData}, '{}'::jsonb), '{eventEndFired}', 'true'::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(entities.id, eventId));
}

export async function runEventEnd(): Promise<RunEventEndResult> {
  const now = new Date();
  const lookbackStart = new Date(
    now.getTime() - LOOKBACK_DAYS * 24 * 3_600_000
  );

  // Event entities whose endDate has crossed `now` (within the look-back window)
  // and that haven't been fired yet.
  const rows = await db.query.entities.findMany({
    where: and(
      eq(entities.type, "event"),
      drizzleSql`${entities.properties}->>'endDate' IS NOT NULL`,
      drizzleSql`(${entities.properties}->>'endDate')::timestamptz <= ${now.toISOString()}`,
      drizzleSql`(${entities.properties}->>'endDate')::timestamptz >= ${lookbackStart.toISOString()}`,
      drizzleSql`COALESCE(${entities.systemData}->>'eventEndFired', 'false') <> 'true'`
    ),
    columns: { id: true, userId: true, workspaceId: true },
  });

  let flipped = 0;
  let stamped = 0;

  for (const event of rows) {
    // Find the ACTIVE focus session bound to this event (event mode).
    const session = await db.query.focusSessions.findFirst({
      where: and(
        eq(focusSessions.subjectEntityId, event.id),
        eq(focusSessions.status, "active")
      ),
      columns: { id: true, userId: true, currentStage: true },
    });

    if (session && session.currentStage !== "post") {
      // Flip as the session owner (no agentUserId) so it auto-applies and emits
      // `focus_session.stage_changed.post`. updateFocusSession is idempotent on
      // an unchanged stage (it only emits on an actual change).
      try {
        const res = await updateFocusSession({
          sessionId: session.id,
          userId: session.userId,
          currentStage: "post",
        });
        if (res.status === "updated") {
          flipped += 1;
        } else {
          logger.warn(
            { sessionId: session.id, status: res.status },
            "event-end: session stage flip did not apply"
          );
        }
      } catch (err) {
        logger.warn(
          { err, sessionId: session.id, eventId: event.id },
          "event-end: session stage flip failed — leaving unstamped for retry"
        );
        // Do NOT stamp on failure so the next tick retries.
        continue;
      }
    }

    // Stamp fired (whether or not there was a session) so we never rescan it.
    await stampFired(event.id).catch((err) =>
      logger.warn({ err, eventId: event.id }, "event-end: fired stamp failed")
    );
    stamped += 1;
  }

  logger.info(
    { scanned: rows.length, flipped, stamped },
    "event-end run complete"
  );

  return { scanned: rows.length, flipped, stamped };
}
