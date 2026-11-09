/**
 * Ask Later Return Worker — an owed ask comes BACK from the person's Later
 * (founder decision D3, 5 Nov 2026): when its time comes, the person is told
 * again, at the ask's level, counted like any other push.
 *
 * The Later door (`services/focus-sessions/ask-later.ts` in @synap/api) sends
 * one job per Later, starting at its `laterUntil`. The handler re-reads the
 * slot and tells the person only when the ask is still owed and still set
 * aside until THAT time: an Undo, a later Later, an answer or a re-ask all
 * change or drop the stamp, so a stale job finds a mismatch and does nothing.
 *
 * Inversion of Control, like `proposal-approve-worker.ts`: jobs must not
 * import @synap/api, so this module owns the QUEUE and a handler SLOT that
 * the api layer fills at boot (apps/api/src/process-role/background-starters.ts).
 *
 * Queue: "ask-later-return"
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "ask-later-return-worker" });

export const ASK_LATER_RETURN_QUEUE = "ask-later-return";

export interface AskLaterReturnPayload {
  sessionId: string;
  /** The slot's stored label (its key or label finds it). */
  label: string;
  /** The `laterUntil` this job was scheduled for, as stored (ISO). */
  laterUntil: string;
}

export interface AskLaterReturnOutcome {
  /** `told`: the person was notified; `stale`: the Later changed; `skipped`: nothing to tell. */
  status: "told" | "stale" | "skipped";
}

type Handler = (p: AskLaterReturnPayload) => Promise<AskLaterReturnOutcome>;

let handler: Handler | null = null;

export function registerAskLaterReturnHandler(fn: Handler): void {
  handler = fn;
}

export async function handleAskLaterReturn(
  job: PgBoss.Job<AskLaterReturnPayload>
): Promise<AskLaterReturnOutcome> {
  if (!handler) {
    throw new Error("ask-later-return handler not registered");
  }
  const outcome = await handler(job.data);
  logger.info(
    { sessionId: job.data.sessionId, status: outcome.status },
    "Ask back from Later"
  );
  return outcome;
}
