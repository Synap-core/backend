/**
 * expireLapsedProposals — retire pending proposals whose MOMENT PASSED.
 *
 * ── Why this is not the TTL that was removed ────────────────────────────────
 * A default `expiresAt` once dropped rows out of the queue with no status
 * change and no notification while `orient` still counted them (the C2 note
 * in `insert-pending-proposal.ts`). This writes a STATUS a reader can see —
 * `EXPIRED`, meaning *nobody decided this*. Nothing disappears.
 *
 * ── Session death is the trigger; this is the BACKSTOP ──────────────────────
 * OpenID CIBA's rule is that a server "is encouraged to terminate the
 * authentication when it knows the client is no longer interested in the
 * result". Closing the focus session is that signal, and `completeSession`
 * fires this for its own proposals directly. This pass exists for the 158 of
 * 441 ephemeral rows that carry NO session at all, and for sessions that die
 * without a clean close.
 *
 * Runs on the existing `stale-proposal-cron` (every 6h) — a second cron for a
 * second reason to walk the same table would be the duplication this codebase
 * keeps paying for.
 */

import {
  db,
  proposals,
  ProposalStatus,
  eq,
  and,
  inArray,
  lt,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  CLASS_LIFETIME_HOURS,
  proposalLifetimeHours,
} from "./proposal-class.js";

const MIN_LIFETIME_MS =
  Math.min(
    ...Object.values(CLASS_LIFETIME_HOURS).filter(
      (h): h is number => h !== null
    )
  ) *
  60 *
  60 *
  1000;

const logger = createLogger({ module: "expire-lapsed-proposals" });

/** The minimum a row must carry for the lapse decision. */
export interface LapseCandidate {
  id: string;
  proposalType: string;
  targetType: string;
  createdAt: Date;
}

/**
 * Which candidates have lapsed — the whole decision, pure and testable.
 *
 * Separated from the query because THIS is where a mistake costs a human their
 * decision. Two properties matter more than the arithmetic:
 *   - a class with a `null` lifetime is never selected, and
 *   - an unrecognised proposalType classifies as `objectWork` (no lifetime), so
 *     a type this code has not been taught can never be swept.
 * Both mean the failure direction is KEEPING a proposal, never losing one.
 *
 * Strictly greater-than: a proposal exactly at its limit is still answerable.
 */
export function selectLapsedIds(
  candidates: readonly LapseCandidate[],
  now: Date
): string[] {
  const out: string[] = [];
  for (const p of candidates) {
    const hours = proposalLifetimeHours(p.proposalType, p.targetType);
    if (hours === null) continue;
    if (now.getTime() - p.createdAt.getTime() > hours * 60 * 60 * 1000) {
      out.push(p.id);
    }
  }
  return out;
}

export interface ExpireLapsedResult {
  scanned: number;
  expired: number;
}

/**
 * Expire every pending proposal past its class lifetime.
 *
 * Classes with a `null` lifetime are never touched, and an unrecognised
 * proposalType falls to `objectWork` (no lifetime) — so this pass fails toward
 * KEEPING a decision, never toward losing one.
 */
export async function expireLapsedProposals(
  now: Date = new Date()
): Promise<ExpireLapsedResult> {
  // Only the columns the class rule reads. Status is the sole filter: a
  // workspace-scoped and a pod-wide proposal lapse identically, so this
  // deliberately does NOT carry `scanStaleProposals`' `isNotNull(workspaceId)`
  // restriction — that scan is about a workspace disappearing, this one is
  // about time passing.
  // Bounded by the SHORTEST lifetime any class has: nothing younger than that
  // can have lapsed, so the index does the work and memory stays flat as the
  // pod grows. The pure decision below still applies each class's own limit.
  const oldestPossiblyLive = new Date(now.getTime() - MIN_LIFETIME_MS);
  const pending = await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.PENDING),
        lt(proposals.createdAt, oldestPossiblyLive)
      )
    );

  const lapsed = selectLapsedIds(pending, now);

  if (lapsed.length === 0) return { scanned: pending.length, expired: 0 };

  // Chunked, and re-asserting PENDING in the WHERE: a human may have approved
  // one of these between the read and the write, and an expiry must never
  // overwrite a real decision.
  const CHUNK = 500;
  let expired = 0;
  for (let i = 0; i < lapsed.length; i += CHUNK) {
    const batch = lapsed.slice(i, i + CHUNK);
    const rows = await db
      .update(proposals)
      .set({ status: ProposalStatus.EXPIRED, updatedAt: now })
      .where(
        and(
          inArray(proposals.id, batch),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      )
      .returning({ id: proposals.id });
    expired += rows.length;
  }

  logger.info(
    { scanned: pending.length, expired },
    "expired lapsed proposals (moment passed, never decided)"
  );
  return { scanned: pending.length, expired };
}

/**
 * Expire a closing session's still-pending EPHEMERAL proposals.
 *
 * The real trigger. Called from `completeSession`, best-effort: a session must
 * close even if this fails, so it never throws.
 *
 * Only classes WITH a lifetime are touched — closing a session must not discard
 * a proposed entity or a merge candidate that happened to be created during it.
 * Those outlive the session by design.
 */
export async function expireSessionEphemerals(
  sessionId: string,
  now: Date = new Date()
): Promise<number> {
  try {
    const pending = await db
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.sessionId, sessionId),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      );

    const ids = pending
      .filter(
        (p) => proposalLifetimeHours(p.proposalType, p.targetType) !== null
      )
      .map((p) => p.id);
    if (ids.length === 0) return 0;

    const rows = await db
      .update(proposals)
      .set({ status: ProposalStatus.EXPIRED, updatedAt: now })
      .where(
        and(
          inArray(proposals.id, ids),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      )
      .returning({ id: proposals.id });

    if (rows.length > 0) {
      logger.info(
        { sessionId, expired: rows.length },
        "session closed — expired its unanswered ephemeral proposals"
      );
    }
    return rows.length;
  } catch (err) {
    // A lens on the queue is worth less than the session close itself.
    logger.warn({ err, sessionId }, "session-close expiry failed (non-fatal)");
    return 0;
  }
}
