/**
 * Presence challenge sweep (review of 6 Nov 2026, W3): every proof of
 * presence starts with a `presence_challenges` row, and nothing ever deleted
 * one, so the table grew with every confirmation asked for.
 *
 * Hourly, delete the challenges that expired more than
 * `PRESENCE_CHALLENGE_RETENTION_HOURS` ago, answered or not. An expired
 * challenge can prove nothing (a proof is checked within 2 minutes; a
 * passkey-change grant is redeemed within 5 minutes of its proof), and the
 * audit of a proof is its `presence.proved` event, never the row.
 */

import { db, lt } from "@synap/database";
import { presenceChallenges } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "presence-challenge-sweep" });

export const PRESENCE_CHALLENGE_SWEEP_QUEUE = "presence-challenge-sweep";
export const PRESENCE_CHALLENGE_SWEEP_CRON = "17 * * * *";

/** How long an expired challenge is kept before the sweep deletes it. */
export const PRESENCE_CHALLENGE_RETENTION_HOURS = 24;

/** Delete the challenges past their retention. Returns how many it deleted. */
export async function handlePresenceChallengeSweep(
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - PRESENCE_CHALLENGE_RETENTION_HOURS * 3600_000
  );
  const deleted = await db
    .delete(presenceChallenges)
    .where(lt(presenceChallenges.expiresAt, cutoff))
    .returning({ id: presenceChallenges.id });
  if (deleted.length > 0) {
    logger.info({ deleted: deleted.length }, "presence challenges swept");
  }
  return deleted.length;
}
