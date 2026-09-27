/**
 * A person who ANSWERS or ATTESTS an ask on an undecided agent draft has taken
 * the draft on (founder decision, 2026-09-27, "draft row carries its asks").
 *
 * Needs-you shows an undecided draft as ONE row ("<agent> started <goal> · asks
 * you N things") and hides its asks individually (`notTriagePendingWhere`).
 * Answering one of those asks is the person saying "yes, this is mine", so the
 * draft is accepted through the ONE acceptance door, `acceptFromTriage` — never
 * a second stamp — and from then on its asks list one by one like any other
 * session's.
 *
 * Called by the answer door (`answerExpectedOutput`) and the attest door
 * (`attestExpectedOutput`) AFTER their write commits. "Not mine" (unblock)
 * never calls it: declining an ask is not taking the draft on.
 *
 * Idempotent: a session that is not a pending draft (a human's own session, one
 * already accepted, a receipt) reads `not_pending` and nothing is written.
 * Best-effort: the answer already landed, so a failed acceptance is logged and
 * never turns a recorded answer into an error.
 */

import { createLogger } from "@synap-core/core";
import { acceptFromTriage } from "./triage.js";

const logger = createLogger({ module: "accept-on-engagement" });

/** `true` when this call accepted the draft; `false` for every other case. */
export async function acceptDraftOnEngagement(input: {
  sessionId: string;
  /** The owner who answered — `acceptFromTriage` owner-floors on it. */
  userId: string;
}): Promise<boolean> {
  try {
    const result = await acceptFromTriage(input);
    return result.ok;
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId },
      "draft acceptance on answer failed — the answer is recorded"
    );
    return false;
  }
}
