/**
 * aiAvailability — this pod's AI availability, for the person asking (C4).
 *
 *   get      the caller's view (payer or member, `readAiAvailabilityFor`):
 *            the state, its one CTA, the payer's link. `availability: null` =
 *            unknown (never pulled, or a CP without the door), never "ok".
 *   recheck  pulls the availability from the Control Plane NOW and answers
 *            the new view. An app calls it right after a successful top-up
 *            checkout, so held work resumes in seconds instead of at the next
 *            pull (a pull that sees AI come back wakes the holds).
 *
 * Any member of the pod may read and re-check it: it carries no billing (no
 * plan, price or pack) and a member's view only ever asks a payer.
 */
import { pullAiAvailabilityNow } from "@synap/jobs/workers/cp-entitlement-sync.js";
import { readAiAvailabilityFor } from "../services/ai-availability/read.js";
import { router, protectedProcedure } from "../trpc.js";

/**
 * A re-check this soon after the last attempt answers what is stored: a
 * double tap or a retry loop never hammers the Control Plane.
 */
const RECHECK_MIN_INTERVAL_MS = 10_000;

export const aiAvailabilityRouter = router({
  get: protectedProcedure.query(({ ctx }) => readAiAvailabilityFor(ctx.userId)),

  recheck: protectedProcedure.mutation(async ({ ctx }) => {
    const before = await readAiAvailabilityFor(ctx.userId);
    const last = before.sync ? Date.parse(before.sync.lastAttemptAt) : NaN;
    if (!(Date.now() - last < RECHECK_MIN_INTERVAL_MS)) {
      await pullAiAvailabilityNow();
    }
    return readAiAvailabilityFor(ctx.userId);
  }),
});
