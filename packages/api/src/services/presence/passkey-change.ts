/**
 * A passkey change (adding or removing one in Kratos' settings flow) when the
 * person already has a proof factor (W3 slice 3, founder decision 2).
 *
 * `presence.authorizePasskeyChange` checks a proof from an existing factor
 * for `passkey_change:<user id>`, which consumes that challenge. Kratos'
 * settings guard (`apps/api/src/webhooks/kratos-cloud-trust.ts`, passkey
 * method) then REDEEMS one such consumed challenge from the last
 * PASSKEY_CHANGE_GRANT_SECONDS (`redeemed_at`, a conditional update): one
 * proof, one change. With no factor yet, no grant is needed: the person's
 * first passkey rests on the guard's pod-credential rule.
 */
import { and, db, drizzleSql, eq, gt, isNull } from "@synap/database";
import { presenceChallenges } from "@synap/database/schema";
import { presenceRequestSubject } from "@synap-core/types/presence";

export const PASSKEY_CHANGE_GRANT_SECONDS = 300;

/** Redeem one passkey-change grant of this person. False when there is none. */
export async function redeemPasskeyChangeGrant(
  userId: string
): Promise<boolean> {
  const since = new Date(Date.now() - PASSKEY_CHANGE_GRANT_SECONDS * 1000);
  const subject = presenceRequestSubject("passkey_change", userId);
  const [grant] = await db
    .select({ id: presenceChallenges.id })
    .from(presenceChallenges)
    .where(
      and(
        eq(presenceChallenges.userId, userId),
        eq(presenceChallenges.subject, subject),
        gt(presenceChallenges.consumedAt, since),
        isNull(presenceChallenges.redeemedAt)
      )
    )
    .orderBy(drizzleSql`${presenceChallenges.consumedAt} desc`)
    .limit(1);
  if (!grant) return false;
  const [redeemed] = await db
    .update(presenceChallenges)
    .set({ redeemedAt: new Date() })
    .where(
      and(
        eq(presenceChallenges.id, grant.id),
        isNull(presenceChallenges.redeemedAt)
      )
    )
    .returning({ id: presenceChallenges.id });
  return Boolean(redeemed);
}
