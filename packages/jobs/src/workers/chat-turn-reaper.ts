/**
 * Chat Turn Reaper
 *
 * Failsafe for durable chat turns that stay `status:'running'` forever when
 * the process crashes mid-stream (API OOM / redeploy SIGTERM / unhandled
 * throw between turn start and the terminal complete/fail write). Without
 * this, diagnose GLOBAL can list them as stuck, but nothing ever finalizes
 * the ledger row — the turn journal never gains a terminal event and the
 * row blocks reconnection semantics forever.
 *
 * Mirrors the automation-run-reaper / focus-session-reaper substrate:
 *   - pure `reapStuckChatTurns({ olderThanHours })` for CLI/manual reuse
 *   - pg-boss cron worker that calls it
 *   - cutoff computed in SQL (`int * interval`) so no Date param is bound
 *     (postgres.js 3.4.8 crashes on Date/object bind params on the pod image)
 *
 * Only touches `running` rows older than the threshold. System job — no
 * USER floor. No new tables.
 */

import { db, and, eq, drizzleSql, chatTurns } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "chat-turn-reaper" });

export const CHAT_TURN_REAPER_QUEUE = "chat-turn-reaper";
/** Every 15 min — with a 2h default window this keeps lag well under one hour. */
export const CHAT_TURN_REAPER_CRON = "*/15 * * * *";

/** Default stuck window (hours). Overridable via `CHAT_TURN_STUCK_HOURS`. */
export const DEFAULT_CHAT_TURN_STUCK_HOURS = 2;

/** Stable error token written on reaped turns (grep-friendly, diagnose-friendly). */
export const STUCK_TIMEOUT_ERROR = "stuck_timeout";

/**
 * Resolve the stuck-hours threshold. Env wins when it parses to a finite
 * positive number; otherwise the default. Exported so tests can lock the
 * parsing contract without re-reading process.env by hand.
 */
export function getChatTurnStuckHours(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.CHAT_TURN_STUCK_HOURS;
  if (raw === undefined || raw === "") return DEFAULT_CHAT_TURN_STUCK_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHAT_TURN_STUCK_HOURS;
  return n;
}

/**
 * Pure-ish reaper: finalize chat_turns that have been `running` longer than
 * `olderThanHours`. Returns the ids that flipped so callers can log/assert.
 *
 * Only touches `status='running'` rows; completed/failed/cancelled are never
 * rewritten. Uses SQL `now() - (N::int * interval '1 hour')` for the cutoff
 * (no Date bind).
 */
export async function reapStuckChatTurns(opts?: {
  olderThanHours?: number;
}): Promise<{ reaped: string[]; olderThanHours: number }> {
  const olderThanHours = opts?.olderThanHours ?? getChatTurnStuckHours();
  // Clamp to int for the SQL cast; fractional hours are not worth the
  // interval arithmetic complexity for a failsafe.
  const hoursInt = Math.max(1, Math.floor(olderThanHours));

  const reaped = await db
    .update(chatTurns)
    .set({
      status: "failed",
      error: STUCK_TIMEOUT_ERROR,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatTurns.status, "running"),
        drizzleSql`${chatTurns.startedAt} < now() - (${hoursInt}::int * interval '1 hour')`
      )
    )
    .returning({ id: chatTurns.id });

  return { reaped: reaped.map((r) => r.id), olderThanHours: hoursInt };
}

/** Called by the cron scheduler every ~15 minutes. */
export async function handleChatTurnReaper(): Promise<void> {
  try {
    const { reaped, olderThanHours } = await reapStuckChatTurns();

    if (reaped.length === 0) {
      logger.debug({ olderThanHours }, "No stuck chat turns to reap");
      return;
    }

    logger.info(
      { reaped: reaped.length, olderThanHours, ids: reaped },
      "Chat turn reaper failed stuck running turns"
    );
  } catch (err) {
    logger.error({ err }, "Chat turn reaper failed");
    throw err; // Let pg-boss handle retry.
  }
}
