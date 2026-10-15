/**
 * The stage worker's irreversible-send CEILING at the send door (work model
 * L4, wave3 contract (d)): past `WORKER_IRREVERSIBLE_DAILY_CEILING` sends in a
 * UTC day, a worker's send is not made — whether it would auto-execute, be
 * filed for review, or is an approved proposal being replayed.
 *
 * The run-start gate (`gateWorkerRun`, run-playbook.ts) only stops a NEW run;
 * one batch can file many sends. So both send doors (`sendExternalMessage`,
 * and `triggerProviderAction` for a write) ask this for every send made
 * inside a session, which is what "per batch item" means here.
 *
 *  - a new send (auto or to be filed): sent today + still pending must be
 *    under the ceiling — filing past it would only queue a send that can
 *    never go;
 *  - an approval replay: sent today must be under it. Its own proposal is one
 *    of the pending ones, so the pending half is not counted.
 *
 * LIMIT: the check needs the session. A door handed none (an IS code skill's
 * provider call, which carries no session) is not counted or refused.
 */
import {
  countWorkerIrreversibleSendsToday,
  countWorkerIrreversibleSentToday,
  workerAutomationOfSession,
} from "@synap/database";
import { db } from "@synap/database";
import { resolveCeiling } from "@synap/database/agent-governance";
import { WORKER_SKIP_REASONS } from "@synap-core/types/workers";

export interface WorkerSendRefusal {
  reason: typeof WORKER_SKIP_REASONS.volumeCeiling;
  message: string;
}

/**
 * ONE worker enablement's irreversible-send ceiling per UTC day (axis
 * `worker_irreversible_sends_daily`, the caps fold). Tighten-only: a row can
 * lower it for one worker, never raise it past the platform limit.
 */
export async function workerIrreversibleSendCeiling(
  automationId: string
): Promise<number> {
  return (
    await resolveCeiling({
      db,
      axis: "worker_irreversible_sends_daily",
      subject: { type: "automation", id: automationId },
    })
  ).value;
}

export async function refuseWorkerSendPastCeiling(opts: {
  sessionId: string | null | undefined;
  /** An approved proposal being replayed (counts what was SENT only). */
  replay: boolean;
}): Promise<WorkerSendRefusal | null> {
  if (!opts.sessionId) return null;
  const automationId = await workerAutomationOfSession(opts.sessionId);
  if (!automationId) return null;
  const used = opts.replay
    ? await countWorkerIrreversibleSentToday(automationId)
    : await countWorkerIrreversibleSendsToday(automationId);
  const ceiling = await workerIrreversibleSendCeiling(automationId);
  if (used < ceiling) return null;
  return {
    reason: WORKER_SKIP_REASONS.volumeCeiling,
    message: `Not sent: this worker reached today's limit of ${ceiling} sends that can't be undone. It can send again tomorrow (UTC).`,
  };
}
