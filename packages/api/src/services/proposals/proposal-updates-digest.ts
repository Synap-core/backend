/**
 * proposalUpdates — tell an agent which of ITS proposals were decided since
 * its last tool call (ticket 437d7370).
 *
 * Nothing used to: an agent learned that its proposal was approved, rejected
 * or failed to apply only by polling `get_proposal`. Observed live: an agent
 * asked the person to approve a limit raise they had approved two minutes
 * earlier (its only source was an older refusal quoting the request as
 * pending), and an `approval_failed` (Apify 401) surfaced only because the
 * person mentioned it.
 *
 * Read from the existing proposal rows: `agent_user_id` = this agent AND
 * `subject_user_id` = the person it acts for (clients that share one agent
 * identity for different people never see each other's decisions or reasons),
 * status in `reportedStatuses()`, decided after the cursor. Every decision
 * door stamps `reviewed_at` (approve, reject, approval_failed).
 *
 * THE CURSOR is process memory, one per (agent, person, session), so two
 * sessions are each told once. `reviewed_at` is an APP clock stamped before
 * its row commits, so it is not monotonic in commit order: a decision stamped
 * just before a read but committed after it would fall behind a plain cursor
 * forever. So every read looks back `OVERLAP_MS` behind the cursor and skips
 * the ids it already reported. Measured limits, by reading: a decision whose
 * commit lags its own stamp by more than `OVERLAP_MS` is missed; a pod restart
 * forgets every cursor (the next call looks back `FIRST_CALL_LOOKBACK_MS`, so
 * a decision just before the restart can be told twice); several API
 * processes keep one cursor each. A failed read does NOT move the cursor.
 *
 * Bounded at `PROPOSAL_UPDATES_MAX`, oldest first; when more were decided, the
 * cursor stops at the last one reported, so the rest arrive on the next call
 * instead of being dropped.
 */
import {
  and,
  asc,
  db,
  eq,
  gt,
  inArray,
  lte,
  notInArray,
  proposals,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { openLink } from "../../utils/deep-links.js";

const logger = createLogger({ module: "proposal-updates-digest" });

export const PROPOSAL_UPDATES_MAX = 10;
/** A cursor's first look back (no call seen yet in this process). */
export const FIRST_CALL_LOOKBACK_MS = 10 * 60 * 1000;
/** How far each read looks back behind its cursor (late commits). */
export const OVERLAP_MS = 2 * 60 * 1000;
/** Cursors kept before the oldest is dropped (it then looks back again). */
const MAX_CURSORS = 5000;

type ReportedStatus =
  | typeof ProposalStatus.APPROVED
  | typeof ProposalStatus.REJECTED
  | typeof ProposalStatus.APPROVAL_FAILED;

/** Read at CALL time: the adapter imports this module, and suites that mock
 *  `@synap/database/schema` must still be able to load the adapter. */
const reportedStatuses = (): ReportedStatus[] => [
  ProposalStatus.APPROVED,
  ProposalStatus.REJECTED,
  ProposalStatus.APPROVAL_FAILED,
];

export interface ProposalUpdate {
  id: string;
  status: ReportedStatus;
  /** What the proposal was about: `<targetType>/<proposalType>`. */
  change: string;
  /** Why it was rejected or failed to apply, when the reviewer / pod said. */
  reason?: string;
  reviewedAt: string;
  reviewUrl: string;
}

interface Cursor {
  at: Date;
  /** Ids reported inside the overlap window → their `reviewed_at` (ms). */
  reported: Map<string, number>;
}

const cursors = new Map<string, Cursor>();

function cursorKey(
  agentUserId: string,
  userId: string,
  sessionId?: string | null
): string {
  return `${agentUserId}\u0000${userId}\u0000${sessionId ?? ""}`;
}

function setCursor(key: string, cursor: Cursor): void {
  cursors.delete(key);
  cursors.set(key, cursor);
  if (cursors.size > MAX_CURSORS) {
    const oldest = cursors.keys().next().value;
    if (oldest !== undefined) cursors.delete(oldest);
  }
}

/** Test seam: forget every cursor. */
export function resetProposalUpdateCursors(): void {
  cursors.clear();
}

/**
 * This agent's proposals for `userId` decided since its last call, and the
 * cursor moved past them. `null` when the read failed (cursor NOT moved).
 */
export async function takeProposalUpdates(
  agentUserId: string,
  userId: string,
  sessionId?: string | null,
  now: Date = new Date()
): Promise<ProposalUpdate[] | null> {
  const key = cursorKey(agentUserId, userId, sessionId);
  const prior = cursors.get(key);
  const since = prior
    ? new Date(prior.at.getTime() - OVERLAP_MS)
    : new Date(now.getTime() - FIRST_CALL_LOOKBACK_MS);
  const alreadyReported = [...(prior?.reported.keys() ?? [])];
  let rows: Array<{
    id: string;
    status: string;
    targetType: string;
    proposalType: string;
    rejectionReason: string | null;
    reviewedAt: Date | null;
  }>;
  try {
    rows = await db
      .select({
        id: proposals.id,
        status: proposals.status,
        targetType: proposals.targetType,
        proposalType: proposals.proposalType,
        rejectionReason: proposals.rejectionReason,
        reviewedAt: proposals.reviewedAt,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.agentUserId, agentUserId),
          eq(proposals.subjectUserId, userId),
          inArray(proposals.status, reportedStatuses()),
          gt(proposals.reviewedAt, since),
          lte(proposals.reviewedAt, now),
          alreadyReported.length > 0
            ? notInArray(proposals.id, alreadyReported)
            : undefined
        )
      )
      .orderBy(asc(proposals.reviewedAt))
      .limit(PROPOSAL_UPDATES_MAX);
  } catch (err) {
    logger.warn({ err, agentUserId }, "proposalUpdates: read failed");
    return null;
  }
  const last = rows[rows.length - 1]?.reviewedAt;
  const at = rows.length === PROPOSAL_UPDATES_MAX && last ? last : now;
  const reported = new Map(prior?.reported ?? []);
  for (const r of rows) reported.set(r.id, (r.reviewedAt ?? now).getTime());
  const floor = at.getTime() - OVERLAP_MS;
  for (const [id, ms] of reported) if (ms <= floor) reported.delete(id);
  setCursor(key, { at, reported });
  return rows.map((r) => ({
    id: r.id,
    status: r.status as ProposalUpdate["status"],
    change: `${r.targetType}/${r.proposalType}`,
    ...(r.status !== ProposalStatus.APPROVED && r.rejectionReason
      ? { reason: r.rejectionReason }
      : {}),
    reviewedAt: (r.reviewedAt ?? now).toISOString(),
    reviewUrl: openLink(r.id),
  }));
}
