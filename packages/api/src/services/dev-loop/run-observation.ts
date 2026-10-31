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
 *
 * VISIBLE: every verdict that says something (delivered, withdrawn, waiting
 * on review, DENIED by the grant) is posted to the session's room as the pod,
 * outside the grant, before a failure throws (`sweep-notice.ts`). A key that
 * holds only `event.create` is denied by design (F1); the room line names the
 * grant it lacks (`session.update`) and the by-hand fallback.
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
import { postSweepNotices } from "./sweep-notice.js";

export type DevLoopRunResult =
  | { status: "swept"; outcomes: MergeSweepOutcome[] }
  | { status: "ignored"; eventType: string }
  /** The payload no longer parses (the door validated it; a replay may not). */
  | { status: "invalid"; error: string };

const SWEEPS = {
  [DEV_LOOP_EVENT_TYPES.prMerged]: {
    sweep: sweepMergedPullRequest,
    kind: "merged",
  },
  [DEV_LOOP_EVENT_TYPES.prClosed]: {
    sweep: sweepClosedPullRequest,
    kind: "closed",
  },
} as const;

export async function runDevLoopObservation(
  job: DevLoopObservationJobData
): Promise<DevLoopRunResult> {
  const entry = SWEEPS[job.eventType as keyof typeof SWEEPS];
  if (!entry) return { status: "ignored", eventType: job.eventType };
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
      entry.sweep({
        userId: job.userId,
        producerAgentUserId: job.producerAgentUserId,
        event: parsed.data,
      })
  );
  // Outside the grant: the pod reports what it did; the key writes nothing.
  await postSweepNotices({
    kind: entry.kind,
    event: parsed.data,
    eventId: job.eventId,
    outcomes,
  });
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
