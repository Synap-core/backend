/**
 * GUEST RETENTION — what an expired public-form submission keeps.
 *
 * A guest proposal carries the answers a stranger typed (name, email, phone,
 * message…), personal data the owner never accepted. The form's
 * `retentionDays` stamps its expiry, and the proposal sweeper
 * (`services/proposals/expire-lapsed-proposals.ts`) expires it; this module
 * then replaces the payload with a tombstone that keeps counts only, so the
 * answers do not outlive the review window.
 *
 * Separate from the sweeper on purpose: a scrub is not an expiry, so it never
 * touches `status` or `updatedAt` (the history lens orders by the time a
 * proposal was decided or expired, and a later scrub must not move it).
 */

import {
  db,
  and,
  eq,
  inArray,
  like,
  drizzleSql,
  proposals,
  users,
  ProposalStatus,
} from "@synap/database";

/**
 * What an expired guest proposal keeps: counts only. The submitted answers
 * (name, email, phone, message…) are personal data the owner never accepted,
 * and `retentionDays` is the promise that they do not outlive the review
 * window. The tombstone still says a submission existed and how big it was.
 */
export function guestProposalTombstone(data: unknown): Record<string, unknown> {
  const asObj = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const outer = asObj(data);
  const inner = asObj(outer?.data) ?? outer;
  const props = asObj(inner?.properties);
  return {
    scrubbed: true,
    reason: "guest_retention_expired",
    fieldCount: props ? Object.keys(props).length : 0,
    hadContent: typeof inner?.content === "string" && inner.content !== "",
  };
}

/**
 * Replace the payload of every EXPIRED guest proposal that still carries one
 * with its tombstone, and drop the dedup hash (a hash of the answers).
 *
 * Selected by state, not by "expired in this scan": a scrub that failed once
 * (or rows expired before this existed) is picked up by the next run instead
 * of keeping the answers forever.
 */
export async function scrubExpiredGuestPayloads(): Promise<number> {
  const formActors = db
    .select({ id: users.id })
    .from(users)
    .where(like(users.agentType, "form:%"));
  const rows = (await db
    .select({ id: proposals.id, data: proposals.data })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.EXPIRED),
        inArray(proposals.agentUserId, formActors),
        drizzleSql`not (coalesce(${proposals.data}, '{}'::jsonb) ? 'scrubbed')`
      )
    )) as Array<{ id: string; data: unknown }>;
  for (const row of rows) {
    await db
      .update(proposals)
      .set({ data: guestProposalTombstone(row.data), dedupHash: null })
      .where(
        and(
          eq(proposals.id, row.id),
          eq(proposals.status, ProposalStatus.EXPIRED)
        )
      );
  }
  return rows.length;
}
