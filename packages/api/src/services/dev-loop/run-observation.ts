/**
 * The api-side runner of the dev-loop job (`@synap/jobs` `dev-loop-worker.ts`,
 * slot filled at boot by apps/api): one recorded fact the pod acts on → the
 * consumer that moves the work it is about.
 *
 * Today: `dev.pr_merged` → the merge sweeper. Every other dev-loop type fires
 * automations only (the trigger hop), so a person or an agent decides in
 * stored config what a CI run or a deploy should move — configuration over
 * code.
 */

import {
  DEV_LOOP_EVENT_TYPES,
  pullRequestEventSchema,
} from "@synap-core/types";
import type { DevLoopObservationJobData } from "@synap/jobs/workers/dev-loop-worker.js";
import {
  sweepMergedPullRequest,
  type MergeSweepOutcome,
} from "./merge-sweeper.js";

export type DevLoopRunResult =
  | { status: "swept"; outcomes: MergeSweepOutcome[] }
  | { status: "ignored"; eventType: string }
  /** The payload no longer parses (the door validated it; a replay may not). */
  | { status: "invalid"; error: string };

export async function runDevLoopObservation(
  job: DevLoopObservationJobData
): Promise<DevLoopRunResult> {
  if (job.eventType !== DEV_LOOP_EVENT_TYPES.prMerged) {
    return { status: "ignored", eventType: job.eventType };
  }
  const parsed = pullRequestEventSchema.safeParse(job.data);
  if (!parsed.success) {
    return {
      status: "invalid",
      error: parsed.error.issues.map((i) => i.message).join("; "),
    };
  }
  const outcomes = await sweepMergedPullRequest({
    userId: job.userId,
    producerAgentUserId: job.producerAgentUserId,
    event: parsed.data,
  });
  return { status: "swept", outcomes };
}
