/**
 * Focus Session Reaper (C8 lifecycle hygiene)
 *
 * Live dogfood found `focus_sessions` rows sitting `status:'active'` for 6+
 * days with zero updates — never closed, never surfaced as stale. A session
 * has no TTL of its own: `createSession`/`updateSession`/the automation
 * `session_update` step all leave it "active" until something explicitly
 * closes it (`completeFocusSession`, the automation run reaper's
 * `closeSessionIfOwned` door, or a user action). A crashed agent, an
 * abandoned chat, or a worker death between "open" and "close" orphans the
 * row forever with no signal to the user that the session is dead.
 *
 * This cron marks such rows `status:'stale'` — non-destructive (the row and
 * its history stay intact; a stale session can still be reopened/completed
 * like any other) — after `REAPER_STALE_HOURS` of no activity.
 *
 * "No activity" is measured off `updatedAt`, NOT `startedAt`: every real touch
 * (progress, stage, goal, output, metadata patch — see update-session.ts,
 * focus-sessions.ts PATCH, hub-protocol/rest/focus-sessions.ts PATCH) bumps
 * `updatedAt`, so a long-running-but-actively-worked session is never reaped
 * on age alone — only genuine silence trips this.
 */

import {
  db,
  and,
  inArray,
  drizzleSql,
  focusSessions,
  AGENT_PROPOSAL_PACKAGE_MARKER,
  RECEIPT_IDLE_WINDOW_HOURS,
  focusSessionWaitsOnPersonWhere,
  personTouchedSubjectIds,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { closeSessionViaDoor } from "../utils/session-close.js";
import { escalateUnacknowledgedReports } from "./track-report-escalation.js";

const logger = createLogger({ module: "focus-session-reaper" });

/**
 * The goal loop's hourly re-check (work model W4) — `sweepGoalLoops` in
 * @synap/api, which this package cannot import: apps/api fills the slot at
 * boot. It rides THIS tick so the loop has no scheduler of its own. Unfilled
 * (a jobs-only process), the tick skips it and says so.
 */
export type GoalLoopSweeper = () => Promise<{
  checked: number;
  proposed: number;
  failed: number;
}>;
let goalLoopSweeper: GoalLoopSweeper | null = null;
export function registerGoalLoopSweeper(fn: GoalLoopSweeper): void {
  goalLoopSweeper = fn;
}

export const FOCUS_SESSION_REAPER_QUEUE = "focus-session-reaper";
export const FOCUS_SESSION_REAPER_CRON = "0 * * * *"; // every hour

/** An `active`/`paused` session untouched this long is presumed abandoned. */
export const REAPER_STALE_HOURS = 24;

/**
 * The staleness predicate, exported so a test can lock its SHAPE: it must key
 * off `updated_at` (bumped by every real touch — progress/stage/goal/output/
 * metadata patch), NEVER `started_at`, or a long-running-but-actively-worked
 * session would be wrongly reaped on age alone.
 *
 * NEVER a session that still owes the person something (W2 calm). A session
 * waiting on the person is QUIET by definition — silence is the person's, not
 * an abandoned agent's — so `updated_at` alone read "waiting on you" as
 * "dead" and staled it while its slot stayed in the needs-you tray (census
 * §3d). The owed predicate is THE one the tray counts with — plus an agent
 * question still open in the room (`focusSessionWaitsOnPersonWhere`): an
 * external agent asks and stops until the answer starts its next run.
 */
export const SESSION_IS_STALE = and(
  drizzleSql`${focusSessions.status} IN ('active', 'paused')`,
  drizzleSql`${focusSessions.updatedAt} < now() - (${REAPER_STALE_HOURS}::int * interval '1 hour')`,
  drizzleSql`NOT ${focusSessionWaitsOnPersonWhere()}`,
  // An open import waits on the person (curating can take days): its
  // `importCuration.phase` is the liveness signal, not `updatedAt`. A LIBRARY
  // run ("Kept from <device>, <day>") is not a curation: it is done once its
  // day has passed — its items live on in the Library regardless.
  drizzleSql`(coalesce(${focusSessions.metadata} -> 'importCuration' ->> 'phase', 'done') = 'done'
    OR ((${focusSessions.metadata} -> 'libraryRun' ->> 'day') < to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')))`
);

/**
 * W-B4 (supervision plan B3, founder Q-B1/Q-B2): an AGENT-opened session that
 * waits on the person but has had no activity for this many days was walked
 * away from. The W2-calm exemption above (a session that owes the person is
 * quiet, not dead) holds for a week of silence, not forever: its agent never
 * came back to withdraw or hand over its asks.
 */
export const AGENT_SESSION_ABANDONED_DAYS = 14;

/**
 * SQL half of the abandoned rule: open, opened by an agent, silent for
 * {@link AGENT_SESSION_ABANDONED_DAYS}, and waiting on the person (the
 * sessions `SESSION_IS_STALE` exempts). The other half — no PERSON ever wrote
 * on it — is `personTouchedSubjectIds`, applied in
 * {@link staleAbandonedAgentSessions}: a session a person worked in is theirs
 * too, and stays exactly as it is.
 */
export const AGENT_SESSION_MAY_BE_ABANDONED = and(
  drizzleSql`${focusSessions.status} IN ('active', 'paused')`,
  drizzleSql`${focusSessions.origin} = 'agent'`,
  drizzleSql`${focusSessions.updatedAt} < now() - (${AGENT_SESSION_ABANDONED_DAYS}::int * interval '1 day')`,
  focusSessionWaitsOnPersonWhere()
);

/** Most abandoned sessions staled per tick. */
const ABANDONED_BATCH = 200;

/**
 * Mark abandoned agent sessions `stale` — only the agent's own: a session a
 * person ever wrote on is never touched. Its asks stay owed, never retired:
 * the agent sees the session in orient's `looseEnds`, and once it has been
 * stale for 30 days the weekly cleanup pack proposes closing it, then
 * withdrawing what it still owes. `updatedAt` is left alone, as in the main
 * sweep. A failed person-touch read stales nothing (it throws).
 */
export async function staleAbandonedAgentSessions(): Promise<number> {
  const candidates = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(AGENT_SESSION_MAY_BE_ABANDONED)
    .limit(ABANDONED_BATCH);
  if (candidates.length === 0) return 0;
  const ids = candidates.map((c) => c.id);
  const touched = await personTouchedSubjectIds(db, "focus_session", ids);
  const abandoned = ids.filter((id) => !touched.has(id));
  if (abandoned.length === 0) return 0;
  const staled = await db
    .update(focusSessions)
    .set({ status: "stale" })
    .where(
      and(inArray(focusSessions.id, abandoned), AGENT_SESSION_MAY_BE_ABANDONED)
    )
    .returning({ id: focusSessions.id });
  return staled.length;
}

/**
 * A write RECEIPT (the session the gate auto-opened to group an agent's writes)
 * that is DONE: idle for the receipt window — no row touch and no proposal
 * filed under it — with nothing left pending. Nothing ever closed receipts, so
 * every one sat open until the stale sweep below mislabelled it abandoned work.
 *
 * Receipts only (`metadata.kind` marker): a session an agent adopted by
 * starting it explicitly lost the marker and is real work, reaped as `stale`
 * like any other. A receipt still holding a pending proposal stays open — its
 * review is not done — and falls to the stale sweep only after 24h.
 */
export const RECEIPT_IS_DONE = and(
  drizzleSql`${focusSessions.status} IN ('active', 'paused')`,
  drizzleSql`${focusSessions.metadata} ->> 'kind' = ${AGENT_PROPOSAL_PACKAGE_MARKER}`,
  drizzleSql`${focusSessions.updatedAt} < now() - (${RECEIPT_IDLE_WINDOW_HOURS}::int * interval '1 hour')`,
  drizzleSql`NOT EXISTS (select 1 from proposals p where p.session_id = ${focusSessions.id} and (p.status = 'pending' or p.created_at > now() - (${RECEIPT_IDLE_WINDOW_HOURS}::int * interval '1 hour')))`,
  // Nothing left to review INCLUDES nothing the person still owes (W2 calm).
  drizzleSql`NOT ${focusSessionWaitsOnPersonWhere()}`
);

/** Most receipts closed per tick — each close runs the full door. */
const RECEIPT_CLOSE_BATCH = 200;

/**
 * Close finished receipts through the ONE close door (`completeFocusSession`
 * via the IoC slot) — status `closed`, never a raw stamp. One failing close is
 * logged and skipped; the rest still close.
 */
export async function closeIdleReceipts(): Promise<number> {
  const done = await db
    .select({ id: focusSessions.id, userId: focusSessions.userId })
    .from(focusSessions)
    .where(RECEIPT_IS_DONE)
    .limit(RECEIPT_CLOSE_BATCH);
  let closed = 0;
  for (const row of done) {
    try {
      const result = await closeSessionViaDoor({
        sessionId: row.id,
        userId: row.userId,
        terminalStatus: "closed",
        summary:
          "Closed automatically: no activity and nothing left to review.",
      });
      if (result) closed++;
    } catch (err) {
      logger.error(
        { err, sessionId: row.id },
        "receipt close failed — will retry next tick"
      );
    }
  }
  return closed;
}

/** Called by the cron scheduler every hour. */
export async function handleFocusSessionReaper(): Promise<void> {
  // R10 (W3) rides this hourly tick: an "impossible" report on a goal that
  // nobody acknowledged for 48 h is escalated to the goal's owner, once. Its
  // own failure never stops the session sweep below.
  try {
    const told = await escalateUnacknowledgedReports();
    if (told > 0) {
      logger.info({ told }, "Escalated unacknowledged goal reports");
    }
  } catch (err) {
    logger.error({ err }, "Goal report escalation failed");
  }
  // The goal loop's re-check (W4). Its own failure never stops the session
  // sweep below.
  if (goalLoopSweeper) {
    try {
      const swept = await goalLoopSweeper();
      if (swept.proposed > 0 || swept.failed > 0) {
        logger.info(swept, "Goal loop re-check");
      }
    } catch (err) {
      logger.error({ err }, "Goal loop re-check failed");
    }
  } else {
    logger.debug("Goal loop sweeper not registered — skipped");
  }
  // Abandoned agent sessions (W-B4). Its own failure never stops the sweep.
  try {
    const abandoned = await staleAbandonedAgentSessions();
    if (abandoned > 0) {
      logger.info(
        { abandoned },
        "Focus session reaper marked abandoned agent sessions stale"
      );
    }
  } catch (err) {
    logger.error({ err }, "Abandoned agent session sweep failed");
  }
  try {
    // Receipts first, so a finished one is CLOSED rather than swept to stale.
    const receiptsClosed = await closeIdleReceipts();
    if (receiptsClosed > 0) {
      logger.info(
        { receiptsClosed },
        "Focus session reaper closed idle receipts"
      );
    }

    // Cutoff computed in SQL (int * interval), no Date param bound — mirrors
    // automation-run-reaper: postgres.js 3.4.8 crashes on Date bind params on
    // the pod image.
    // Only the status changes — `updatedAt` is deliberately LEFT ALONE: it is the
    // last-real-activity signal SESSION_IS_STALE keys off, so overwriting it would
    // erase when the session actually went quiet (and a stale row no longer matches
    // the predicate, so it is never re-reaped regardless). Not binding a `new Date()`
    // here also avoids the postgres.js 3.4.8 Date-bind crash the cutoff above dodges.
    const reaped = await db
      .update(focusSessions)
      .set({ status: "stale" })
      .where(SESSION_IS_STALE)
      .returning({ id: focusSessions.id });

    if (reaped.length === 0) {
      logger.debug("No stale focus sessions to reap");
      return;
    }

    logger.info(
      { reaped: reaped.length },
      "Focus session reaper marked stale sessions"
    );
  } catch (err) {
    logger.error({ err }, "Focus session reaper failed");
    throw err; // Let pg-boss handle retry.
  }
}
