/**
 * Session recall — when a focus session starts, look for raw captures and
 * notes the person already has that could help it, and put them in front of
 * both the person and the session's agent (founder precision, 2026-10-08:
 * "capture is not necessarily creating a process … they could be revived when
 * a session is started that could need them").
 *
 * TWO queues, ONE runner:
 *   • `session-recall` (on-demand) — `{ sessionId }`. Enqueued by the session
 *     creation doors for immediacy, and by the manual "recall again" route.
 *     Singleton per session, so a burst of doors collapses to one run.
 *   • `session-recall-sweep` (cron, every 2 min) — the FLOOR that makes "every
 *     start door" true BY DERIVATION rather than by a hand-kept list of hooks:
 *     any open session started recently that carries no recall marker
 *     (`metadata.recalledAt`) is recalled now, whichever door minted it
 *     (`openRunSession`, the proposal executor, sync, a door added next month).
 *     A FAILED recall is retried by the sweep at most `RECALL_MAX_ATTEMPTS`
 *     times, `RECALL_RETRY_AFTER_MINUTES` apart; an EMPTY one never is.
 *
 * The runner lives api-side (retrieval + the message door are there) and is
 * handed in through an IoC slot, because @synap/jobs cannot statically import
 * @synap/api (circular dep) — same pattern as fireflies / cal-backfill.
 *
 * The runner NEVER throws for a recall failure: it records
 * `metadata.recallError` on the session so a failed recall is distinguishable
 * from an empty one. A throw here is a bug in the runner itself, and pg-boss
 * retries it.
 */

import type PgBoss from "pg-boss";
import { db, drizzleSql, focusSessions } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "session-recall-worker" });

export const SESSION_RECALL_QUEUE = "session-recall";
export const SESSION_RECALL_SWEEP_QUEUE = "session-recall-sweep";
export const SESSION_RECALL_SWEEP_CRON = "*/2 * * * *";

/** Sessions recalled per sweep tick (each costs two embeddings + a retrieval). */
export const RECALL_SWEEP_BATCH = 20;
/** Only sessions started this recently are swept — history is left alone. */
export const RECALL_SWEEP_LOOKBACK_HOURS = 6;
/** A failed recall is retried by the sweep at most this many times in total. */
export const RECALL_MAX_ATTEMPTS = 3;
export const RECALL_RETRY_AFTER_MINUTES = 10;

/** `metadata.source` of an agent's write receipt — not a session anyone started. */
const RECEIPT_SOURCE = "agent-write";

export interface SessionRecallJobData {
  sessionId: string;
  /** Why this run was asked for — logged, and stamped on the session. */
  trigger?: "start" | "sweep" | "manual";
}

export type SessionRecallRunner = (input: SessionRecallJobData) => Promise<{
  status: string;
}>;

let sessionRecallRunner: SessionRecallRunner | null = null;

export function registerSessionRecallRunner(fn: SessionRecallRunner): void {
  sessionRecallRunner = fn;
}

/** For tests: whether the api side filled the slot. */
export function hasSessionRecallRunner(): boolean {
  return sessionRecallRunner !== null;
}

export async function handleSessionRecall(job: PgBoss.Job): Promise<void> {
  if (!sessionRecallRunner) {
    logger.warn("session-recall runner not registered — skipping job");
    return;
  }
  const data = job.data as SessionRecallJobData;
  if (!data?.sessionId) {
    logger.warn({ data }, "session-recall: malformed job payload — dropping");
    return;
  }
  const result = await sessionRecallRunner(data);
  logger.info(
    { sessionId: data.sessionId, status: result.status },
    "session-recall complete"
  );
}

/**
 * The sweep's candidate predicate, in SQL (exported so a PGlite test can drive
 * the real one): open, started within the lookback, not an agent's write
 * receipt, and either never recalled or failed with attempts left and the
 * cool-off elapsed.
 */
export function recallSweepCandidatesWhere() {
  return drizzleSql`(
    ${focusSessions.status} IN ('active', 'paused', 'forming')
    AND ${focusSessions.startedAt} > now() - make_interval(hours => ${RECALL_SWEEP_LOOKBACK_HOURS})
    AND (${focusSessions.metadata}->>'source' IS DISTINCT FROM ${RECEIPT_SOURCE})
    AND (
      ${focusSessions.metadata}->>'recalledAt' IS NULL
      OR (
        (${focusSessions.metadata}->'recallError') IS NOT NULL
        AND COALESCE((${focusSessions.metadata}->>'recallAttempts')::int, 1) < ${RECALL_MAX_ATTEMPTS}
        AND (${focusSessions.metadata}->>'recalledAt')::timestamptz
              < now() - make_interval(mins => ${RECALL_RETRY_AFTER_MINUTES})
      )
    )
  )`;
}

export async function handleSessionRecallSweep(
  _job?: PgBoss.Job
): Promise<{ swept: number }> {
  if (!sessionRecallRunner) {
    logger.warn("session-recall runner not registered — skipping sweep tick");
    return { swept: 0 };
  }
  try {
    const rows = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(recallSweepCandidatesWhere())
      .orderBy(focusSessions.startedAt)
      .limit(RECALL_SWEEP_BATCH);
    for (const row of rows) {
      // One at a time: each is two embeddings + a retrieval; a burst of
      // automation runs must not fan out into a burst of IS calls.
      await sessionRecallRunner({ sessionId: row.id, trigger: "sweep" });
    }
    return { swept: rows.length };
  } catch (err) {
    // A cron must not retry-storm; the next tick picks the rows up again.
    logger.error({ err }, "session-recall sweep failed");
    return { swept: 0 };
  }
}
