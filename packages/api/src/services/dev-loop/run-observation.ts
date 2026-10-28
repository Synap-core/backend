/**
 * The api-side runner of the dev-loop job (`@synap/jobs` `dev-loop-worker.ts`,
 * slot filled at boot by apps/api): one recorded fact the pod acts on → the
 * consumer that moves the work it is about.
 *
 * Today: `dev.pr_merged` → the PR outcome is completed, `dev.pr_closed` → it
 * is withdrawn (`merge-sweeper.ts`). Every other dev-loop type fires
 * automations only (the trigger hop), so a person or an agent decides in
 * stored config what a CI run or a deploy should move — configuration over
 * code.
 *
 * GRANT (founder F1): the sweep runs inside the grant of the key that posted
 * the fact, carried in the job (`DevLoopObservationJobData.grant`, as a
 * deferred write carries its grant). The request that recorded the fact is
 * gone by the time the job runs, so without it `checkPermissionOrPropose`
 * would see "no grant" (a legacy key) and a key allowed only `event.create`
 * could complete any outcome it names a PR of.
 *
 * A `failed` outcome (a transient error) THROWS once every session was tried,
 * so pg-boss retries the job: the sweep is idempotent (a settled slot is
 * skipped), and no producer replays a fact it already delivered.
 */

import {
  DEV_LOOP_EVENT_TYPES,
  pullRequestEventSchema,
} from "@synap-core/types";
import { runWithGrant, type KeyGrant } from "@synap/database";
import type { DevLoopObservationJobData } from "@synap/jobs/workers/dev-loop-worker.js";
import {
  sweepClosedPullRequest,
  sweepMergedPullRequest,
  type MergeSweepOutcome,
} from "./merge-sweeper.js";

export type DevLoopRunResult =
  | { status: "swept"; outcomes: MergeSweepOutcome[] }
  | { status: "ignored"; eventType: string }
  /** The payload no longer parses (the door validated it; a replay may not). */
  | { status: "invalid"; error: string };

const SWEEPS = {
  [DEV_LOOP_EVENT_TYPES.prMerged]: sweepMergedPullRequest,
  [DEV_LOOP_EVENT_TYPES.prClosed]: sweepClosedPullRequest,
} as const;

export async function runDevLoopObservation(
  job: DevLoopObservationJobData
): Promise<DevLoopRunResult> {
  const sweep = SWEEPS[job.eventType as keyof typeof SWEEPS];
  if (!sweep) return { status: "ignored", eventType: job.eventType };
  const parsed = pullRequestEventSchema.safeParse(job.data);
  if (!parsed.success) {
    return {
      status: "invalid",
      error: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  const outcomes = await runWithGrant(
    job.grant as unknown as KeyGrant | null | undefined,
    () =>
      sweep({
        userId: job.userId,
        producerAgentUserId: job.producerAgentUserId,
        event: parsed.data,
      })
  );
  const failed = outcomes.filter((o) => o.result === "failed");
  if (failed.length > 0) {
    throw new Error(
      `dev-loop sweep of ${job.eventType} (event ${job.eventId}) failed for ${failed
        .map((o) => `${o.sessionId}/${o.slotKey}: ${o.reason ?? "unknown"}`)
        .join("; ")}`
    );
  }
  return { status: "swept", outcomes };
}
