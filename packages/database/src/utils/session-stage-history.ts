/**
 * THE ONE APPEND of `focus_sessions.stage_history` (0382).
 *
 * The stage ledger of a session: every stage it entered, oldest first, in the
 * shape of a goal's `project_tracks.stage_history` (0274). It is written ONLY
 * here, as a SQL fragment the caller puts in the SAME `.set({...})` that
 * writes `current_stage` — so an entry exists iff the move landed. A stage
 * move is never written to `lifecycle_transition_outbox`: `listHolds` reads a
 * subject's latest transition whatever its property, so a stage row there
 * would hide a paused session's hold (effects 4928e33b finding 2).
 *
 * The tripwire `__tripwires__/current-stage-one-door.test.ts` requires every
 * file that writes `current_stage` to call this, or to be a named exception.
 */
import { sql as drizzleSql } from "drizzle-orm";
import { focusSessions } from "../schema/focus-sessions.js";
import type { SessionStageHistoryEntry } from "../schema/focus-sessions.js";

export interface SessionStageMove {
  fromStage: string | null;
  toStage: string;
  /** The human the move is attributed to. */
  userId: string;
  /** Set when an agent drove it; it is then the entry's `actor`. */
  agentUserId?: string | null;
  via: SessionStageHistoryEntry["via"];
  /** Defaults to now. */
  at?: Date;
}

/** The entry one move appends. Pure. */
export function sessionStageHistoryEntry(
  move: SessionStageMove
): SessionStageHistoryEntry {
  return {
    stageKey: move.toStage,
    fromStage: move.fromStage,
    enteredAt: (move.at ?? new Date()).toISOString(),
    actor: move.agentUserId || move.userId,
    userId: move.userId,
    via: move.via,
  };
}

/**
 * `stage_history || [entry]`, for the `.set({ stageHistory })` of the UPDATE
 * that writes `current_stage`. Never call it for a no-op move (from = to).
 */
export function appendSessionStageHistory(move: SessionStageMove) {
  return drizzleSql`(COALESCE(${focusSessions.stageHistory}, '[]'::jsonb) || ${JSON.stringify(
    [sessionStageHistoryEntry(move)]
  )}::jsonb)`;
}
