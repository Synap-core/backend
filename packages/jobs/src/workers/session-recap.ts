/**
 * Session Recap Worker
 *
 * On-demand queue (NOT a cron). Enqueued by the `session-recap-trigger` reactor
 * in @synap/events when a focus session flips to the `post` stage (event mode:
 * the event's endDate crossed → the session bound to it advances to `post`).
 *
 * Thin delegator: the recap reads the session's produced entities, asks the
 * Intelligence Service to summarize who/what was captured + propose concrete
 * follow-ups, posts the summary to the session's channel, and surfaces the
 * follow-ups as ONE governed proposal. All of that is api-side (getLinksFor, IS
 * transport, insertChannelMessage, checkPermissionOrPropose), so — like the
 * event-sync / event-end runners — @synap/api fills the `sessionRecapRunner`
 * slot at boot via `registerSessionRecapRunner()` (jobs can't import api).
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "session-recap" });

export const SESSION_RECAP_QUEUE = "session-recap";

export interface SessionRecapJob {
  sessionId: string;
  userId: string;
  workspaceId?: string | null;
}

type SessionRecapRunner = (input: SessionRecapJob) => Promise<unknown>;

let sessionRecapRunner: SessionRecapRunner | null = null;

export function registerSessionRecapRunner(fn: SessionRecapRunner): void {
  sessionRecapRunner = fn;
}

export async function handleSessionRecap(
  job: PgBoss.Job<SessionRecapJob>
): Promise<void> {
  if (!sessionRecapRunner) {
    logger.warn("session-recap runner not registered — skipping job");
    return;
  }

  const { sessionId, userId, workspaceId } =
    job.data ?? ({} as SessionRecapJob);
  if (!sessionId || !userId) {
    logger.warn(
      { data: job.data },
      "session-recap job missing sessionId/userId"
    );
    return;
  }

  try {
    const result = await sessionRecapRunner({ sessionId, userId, workspaceId });
    logger.info({ sessionId, result }, "session-recap run complete");
  } catch (err) {
    logger.error({ err, sessionId }, "session-recap run failed");
  }
}
