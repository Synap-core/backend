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
  drizzleSql,
  focusSessions,
  AGENT_PROPOSAL_PACKAGE_MARKER,
  RECEIPT_IDLE_WINDOW_HOURS,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { closeSessionViaDoor } from "../utils/session-close.js";

const logger = createLogger({ module: "focus-session-reaper" });

export const FOCUS_SESSION_REAPER_QUEUE = "focus-session-reaper";
export const FOCUS_SESSION_REAPER_CRON = "0 * * * *"; // every hour

/** An `active`/`paused` session untouched this long is presumed abandoned. */
export const REAPER_STALE_HOURS = 24;

/**
 * The staleness predicate, exported so a test can lock its SHAPE: it must key
 * off `updated_at` (bumped by every real touch — progress/stage/goal/output/
 * metadata patch), NEVER `started_at`, or a long-running-but-actively-worked
 * session would be wrongly reaped on age alone.
 */
export const SESSION_IS_STALE = and(
  drizzleSql`${focusSessions.status} IN ('active', 'paused')`,
  drizzleSql`${focusSessions.updatedAt} < now() - (${REAPER_STALE_HOURS}::int * interval '1 hour')`
);

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
  drizzleSql`NOT EXISTS (select 1 from proposals p where p.session_id = ${focusSessions.id} and (p.status = 'pending' or p.created_at > now() - (${RECEIPT_IDLE_WINDOW_HOURS}::int * interval '1 hour')))`
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
