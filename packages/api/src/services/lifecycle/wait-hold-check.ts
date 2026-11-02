/**
 * THE trigger for holds that wait on the person (plan 07f8a997 "Agents wait
 * on anything", W1 part C): `until.moves` = `answer:<session>/<slot>` or
 * `proposal:<id>`. Sent by the answer door (`answerExpectedOutput`) once an
 * answer is recorded, and by the review door (`emitProposalReviewed`) once a
 * proposal is decided; the hold-resume job (`@synap/jobs`) re-checks the wait
 * holds that name it and resumes the met ones, so a sleeping agent's session
 * comes back now rather than at the hourly sweep.
 *
 * Best-effort, like the dev-fact trigger (`record-observation.ts`): a failed
 * send is logged and the hourly sweep finds the hold anyway. Never throws.
 */
import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";
import {
  HOLD_RESUME_QUEUE,
  type HoldResumeJobData,
} from "@synap/jobs/workers/hold-resume.js";

const logger = createLogger({ module: "wait-hold-check" });

export async function sendWaitHoldCheck(
  waits: NonNullable<HoldResumeJobData["waits"]>,
  /** One send per landing (an answer's time, a proposal's decision). */
  singletonKey: string
): Promise<void> {
  try {
    await getBoss().send(
      HOLD_RESUME_QUEUE,
      { waits } satisfies HoldResumeJobData,
      { singletonKey: `hold-resume:wait:${singletonKey}` }
    );
  } catch (err) {
    logger.warn(
      { err, waits },
      "wait hold check not sent — the hourly sweep resumes what waited on it"
    );
  }
}
