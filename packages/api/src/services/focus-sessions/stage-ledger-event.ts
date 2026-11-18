/**
 * THE id of one stage-ledger entry as an event (`focus_sessions.stage_history`,
 * 0382). Three readers turn the ledger into events: the change feed
 * (`stage_moved`, `session-changes.ts`), the timeline (`stage_moved`,
 * `read-timeline.ts`) and `statusOf`'s history (`stage_entered`,
 * `status-read.ts`). They project different shapes for their own doors, but
 * one entry is one id everywhere, stable from the entry itself (when it was
 * entered, and which stage), never from its position in a read: a client
 * that holds an event from one door recognises it in another, and a
 * truncated read does not renumber it.
 */
import type { SessionStageHistoryEntry } from "@synap/database";

export function stageLedgerEventId(
  sessionId: string,
  entry: Pick<SessionStageHistoryEntry, "enteredAt" | "stageKey">
): string {
  return `stage:${sessionId}:${entry.enteredAt}:${entry.stageKey}`;
}
