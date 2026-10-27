/**
 * Dev Loop Worker — the pod moving when the world moved (plan v5 T2).
 *
 * The observation door (api `services/observations/record-observation.ts`)
 * enqueues one job per recorded dev-loop fact the pod ACTS on (today
 * `dev.pr_merged`: the merge sweeper completes the session outcome that is
 * the PR). The work itself is api-side (session doors, governance, criteria);
 * @synap/jobs cannot import @synap/api (api → jobs → database), so apps/api
 * fills the runner slot at boot via `registerDevLoopRunner()` — the
 * entity-media-copy IoC pattern.
 *
 * Failure posture: a job that starts before the runner is registered waits
 * for it, then THROWS (pg-boss records a failed job — never a silent done).
 * A runner failure is logged and RE-THROWN, so pg-boss retries it
 * (`DEV_LOOP_SEND_OPTIONS`): no producer replays a fact it already delivered
 * (the devbox marks a PR seen, GitHub posts once), and the sweeper is
 * idempotent (a settled slot is skipped), so a retry is the only way a
 * transient error is not permanent.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import type { DeferredWriteGrant } from "@synap-core/types/proposals/deferred-writes";

const logger = createLogger({ module: "dev-loop-worker" });

export const DEV_LOOP_OBSERVATION_QUEUE = "dev-loop-observation";

/** Job payload the observation door enqueues onto DEV_LOOP_OBSERVATION_QUEUE. */
export interface DevLoopObservationJobData {
  /** The observation type (`dev.pr_merged`). */
  eventType: string;
  /** The observation's payload, as recorded. */
  data: Record<string, unknown>;
  /** The person whose key posted it — every session door's owner floor. */
  userId: string;
  /** The agent that posted it, when one did — the governed actor. */
  producerAgentUserId: string | null;
  /** The recorded observation's event row. */
  eventId: string;
  /**
   * The grant that bounded the posting key (null for a key with none). The
   * sweep runs inside it again, exactly as a deferred write's replay does, so
   * the pod never acts further than the key could (founder F1).
   */
  grant: DeferredWriteGrant | null;
}

/** pg-boss send options of the queue: a failed sweep is retried, backing off. */
export const DEV_LOOP_SEND_OPTIONS: PgBoss.SendOptions = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
};

type DevLoopRunner = (input: DevLoopObservationJobData) => Promise<unknown>;

let devLoopRunner: DevLoopRunner | null = null;
let announceRunner: (() => void) | null = null;
let runnerRegistered = new Promise<void>((resolve) => {
  announceRunner = resolve;
});

/** How long a job that starts before the runner is registered waits for it. */
export const DEV_LOOP_RUNNER_WAIT_MS = 60_000;

export function registerDevLoopRunner(fn: DevLoopRunner): void {
  devLoopRunner = fn;
  announceRunner?.();
}

/** Test seam: forget the registered runner. */
export function resetDevLoopRunnerForTests(): void {
  devLoopRunner = null;
  runnerRegistered = new Promise<void>((resolve) => {
    announceRunner = resolve;
  });
}

async function awaitRunner(waitMs: number): Promise<DevLoopRunner | null> {
  if (devLoopRunner) return devLoopRunner;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    runnerRegistered,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  clearTimeout(timer);
  return devLoopRunner;
}

export async function handleDevLoopObservation(
  job: PgBoss.Job,
  opts: { waitMs?: number } = {}
): Promise<void> {
  const runner = await awaitRunner(opts.waitMs ?? DEV_LOOP_RUNNER_WAIT_MS);
  if (!runner) {
    throw new Error("dev-loop runner not registered — the job did not run");
  }
  const data = job.data as DevLoopObservationJobData;
  if (!data?.eventType || !data.userId) {
    logger.warn({ data }, "dev-loop: malformed job payload — dropping");
    return;
  }
  try {
    const result = await runner(data);
    logger.info(
      { eventType: data.eventType, eventId: data.eventId, result },
      "dev-loop observation handled"
    );
  } catch (err) {
    logger.error(
      { err, eventType: data.eventType, eventId: data.eventId },
      "dev-loop observation failed (pg-boss retries it)"
    );
    throw err;
  }
}
