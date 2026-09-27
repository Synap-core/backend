/**
 * GUEST RETENTION — what a public-form submission keeps once it will never be
 * accepted.
 *
 * A guest proposal carries the answers a stranger typed (name, email, phone,
 * message…), personal data the owner never accepted. Two ways it ends without
 * being accepted, one scrub for both:
 *   - EXPIRED: the form's `retentionDays` stamps its expiry and the proposal
 *     sweeper (`services/proposals/expire-lapsed-proposals.ts`) expires it;
 *   - REJECTED: the owner said no (`proposals.reject` / `batchReject`), so there
 *     is nothing left to review the answers for.
 * The payload is replaced with a tombstone that keeps counts only. The reject
 * doors scrub the rows they just rejected; the sweeper re-runs the same scrub
 * by STATE, so a scrub that failed inline is finished on its next pass.
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
export function guestProposalTombstone(
  data: unknown,
  reason:
    "guest_retention_expired" | "guest_rejected" = "guest_retention_expired"
): Record<string, unknown> {
  const asObj = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const outer = asObj(data);
  const inner = asObj(outer?.data) ?? outer;
  const props = asObj(inner?.properties);
  return {
    scrubbed: true,
    reason,
    fieldCount: props ? Object.keys(props).length : 0,
    hadContent: typeof inner?.content === "string" && inner.content !== "",
  };
}

/** True when a proposal's payload is a guest tombstone (its answers are gone). */
export function isScrubbedGuestPayload(data: unknown): boolean {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).scrubbed === true
  );
}

const CLOSED_STATUSES = [ProposalStatus.EXPIRED, ProposalStatus.REJECTED];

/**
 * Replace the payload of every EXPIRED or REJECTED guest proposal that still
 * carries one with its tombstone, and drop the dedup hash (a hash of the
 * answers). `proposalIds` narrows it to those rows (the reject doors pass the
 * ids they just rejected); a non-guest or still-pending id is never touched.
 *
 * Selected by state, not by "expired in this scan": a scrub that failed once
 * (or rows closed before this existed) is picked up by the next run instead of
 * keeping the answers forever. The status is re-asserted on the write, so a row
 * reopened in between keeps its answers.
 */
export async function scrubGuestPayloads(
  opts: { proposalIds?: readonly string[] } = {}
): Promise<number> {
  if (opts.proposalIds && opts.proposalIds.length === 0) return 0;
  const formActors = db
    .select({ id: users.id })
    .from(users)
    .where(like(users.agentType, "form:%"));
  const rows = (await db
    .select({
      id: proposals.id,
      data: proposals.data,
      status: proposals.status,
    })
    .from(proposals)
    .where(
      and(
        inArray(proposals.status, CLOSED_STATUSES),
        inArray(proposals.agentUserId, formActors),
        drizzleSql`not (coalesce(${proposals.data}, '{}'::jsonb) ? 'scrubbed')`,
        ...(opts.proposalIds
          ? [inArray(proposals.id, [...opts.proposalIds])]
          : [])
      )
    )) as Array<{
    id: string;
    data: unknown;
    status: (typeof CLOSED_STATUSES)[number];
  }>;
  for (const row of rows) {
    await db
      .update(proposals)
      .set({
        data: guestProposalTombstone(
          row.data,
          row.status === ProposalStatus.REJECTED
            ? "guest_rejected"
            : "guest_retention_expired"
        ),
        dedupHash: null,
      })
      .where(and(eq(proposals.id, row.id), eq(proposals.status, row.status)));
  }
  return rows.length;
}
