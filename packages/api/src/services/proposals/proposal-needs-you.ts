/**
 * THE needs-you rule over a page of pending proposals (`classifyPendingProposal`,
 * `@synap-core/types/needs-you/rule`, decision E6): needs you only when
 * something WAITS on it (W3 `resolveProposalWaits`: a gate, an owed slot, a
 * parked run) on work that has not ended; a non-gate wait on a session an
 * agent is working waits there (F2); a wait older than 7 days goes to Review
 * later (a gate never ages); every other pending proposal is a change to
 * review — its own count.
 *
 * Batched: the waits read (two queries) plus one session read (status and
 * the rule's session class, `needsYouSessionClassSql`), through the ONE
 * session read rule. A session the reader may not read stays `null`, which
 * the rule reads as open: a proposal is never demoted on a session nobody let
 * us see.
 *
 * "Later" (`proposal_snoozes`, founder decision G3): the READER's own
 * set-asides are read in the same batch, so a request they put off is Review
 * later for them until its time and unchanged for everyone else.
 *
 * A failed read THROWS, like `resolveProposalWaits`: "nothing waits" and
 * "could not tell" are different facts.
 */

import {
  db,
  and,
  eq,
  gt,
  inArray,
  focusSessions,
  proposalSnoozes,
  needsYouSessionClassSql,
  drizzleSql,
} from "@synap/database";
import {
  classifyPendingProposal,
  type NeedsYouProposalClass,
  type NeedsYouSessionClass,
} from "@synap-core/types/needs-you/rule";
import {
  sessionReadableWhere,
  type SessionReader,
} from "../../access/session-visibility.js";
import {
  resolveProposalWaits,
  type ProposalWaitsRow,
} from "./proposal-waits.js";

export interface ProposalNeedsYouRow extends ProposalWaitsRow {
  createdAt: Date | string;
}

const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** id → class, for every PENDING row (a decided row has no class). */
export async function classifyPendingProposals(
  rows: readonly ProposalNeedsYouRow[],
  reader: SessionReader,
  now: Date = new Date()
): Promise<Map<string, NeedsYouProposalClass>> {
  const pending = rows.filter((r) => r.status === "pending");
  const out = new Map<string, NeedsYouProposalClass>();
  if (pending.length === 0) return out;
  const sessionIds = [
    ...new Set(
      pending
        .map((r) => r.sessionId)
        .filter((id): id is string => !!id && isUuid(id))
    ),
  ];
  const proposalIds = pending.map((r) => r.id).filter(isUuid);
  const [waits, sessions, snoozes] = await Promise.all([
    resolveProposalWaits(pending, reader),
    sessionIds.length > 0
      ? db
          .select({
            id: focusSessions.id,
            status: focusSessions.status,
            sessionClass: drizzleSql<NeedsYouSessionClass>`${needsYouSessionClassSql("focus_sessions", now)}`,
          })
          .from(focusSessions)
          .where(
            and(
              inArray(focusSessions.id, sessionIds),
              sessionReadableWhere(reader)
            )
          )
      : Promise.resolve(
          [] as Array<{
            id: string;
            status: string;
            sessionClass: NeedsYouSessionClass;
          }>
        ),
    proposalIds.length > 0
      ? db
          .select({
            proposalId: proposalSnoozes.proposalId,
            snoozedUntil: proposalSnoozes.snoozedUntil,
          })
          .from(proposalSnoozes)
          .where(
            and(
              eq(proposalSnoozes.userId, reader.userId),
              inArray(proposalSnoozes.proposalId, proposalIds),
              gt(proposalSnoozes.snoozedUntil, now)
            )
          )
      : Promise.resolve(
          [] as Array<{ proposalId: string; snoozedUntil: Date }>
        ),
  ]);
  const sessionOf = new Map(sessions.map((s) => [s.id, s]));
  const snoozedUntilOf = new Map(
    snoozes.map((s) => [s.proposalId, s.snoozedUntil])
  );
  for (const row of pending) {
    const sessionId = row.sessionId ?? null;
    const session = sessionId ? sessionOf.get(sessionId) : undefined;
    const cls = classifyPendingProposal(
      {
        status: row.status,
        createdAt: row.createdAt,
        waits: waits.get(row.id) ?? { waits: false },
        sessionId,
        sessionStatus: session?.status ?? null,
        sessionClass: session?.sessionClass ?? null,
        snoozedUntil: snoozedUntilOf.get(row.id) ?? null,
      },
      now
    );
    if (cls) out.set(row.id, cls);
  }
  return out;
}

/** How many clusters out of the headline sit in each of the rule's folds. */
export interface ClusterFoldCounts {
  working: number;
  reviewLater: number;
  changesToReview: number;
}

/**
 * Of the clusters OUT of the headline (`reviewLater`), how many sit in each
 * fold: the cluster's class when the read classed it, else Review later (an
 * older read's flag). ONE derivation for the groups door and every scoped
 * count over its clusters.
 */
export function clusterFoldCounts(
  clusters: ReadonlyArray<{
    reviewLater?: boolean;
    needsYouClass?: NeedsYouProposalClass | null;
  }>
): ClusterFoldCounts {
  const counts: ClusterFoldCounts = {
    working: 0,
    reviewLater: 0,
    changesToReview: 0,
  };
  for (const c of clusters) {
    if (!c.reviewLater) continue;
    if (c.needsYouClass === "working") counts.working += 1;
    else if (c.needsYouClass === "changes_to_review")
      counts.changesToReview += 1;
    else counts.reviewLater += 1;
  }
  return counts;
}
