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

import { isDocumentEditProposal } from "@synap-core/types/proposals/intent";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";
import {
  db,
  proposals,
  users,
  ProposalStatus,
  eq,
  and,
  inArray,
  isNotNull,
  like,
  lt,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { discardProposalSourceBlob } from "../../utils/store-entity-source-blob.js";
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

/**
 * SESSION-BOUND DRAFTS: document edits — they die when their session closes,
 * but no clock ever sweeps them.
 *
 * Why a second rule rather than a lifetime on the class: a document edit
 * proposal is `objectWork` and that classification is right — a draft of a
 * document is exactly as reviewable next week as today, so the 6-hourly cron
 * must never touch it. What it is NOT is reviewable after the session that
 * produced it is gone: the agent's reasoning, its context and the reader's own
 * attention all left with the session, and an unanswered draft outliving them
 * is queue debt, not a decision anyone still owes. Session close is a signal
 * the clock does not have, so it gets its own predicate.
 *
 * The rule is `isDocumentEditProposal` (`@synap-core/types/proposals/intent`):
 * the patch door's types on a document, plus the legacy `ai_edit`. ONE
 * classifier, also read by the browser's close moment to say which pending
 * drafts this close PROVABLY expires — so the pod and the sentence cannot
 * disagree. Keyed on the (targetType, proposalType) PAIR: an entity `update`
 * outlives the session.
 */
export const isSessionBoundDraft = isDocumentEditProposal;

/**
 * Does closing a session retire this pending proposal?
 *
 * Two independent reasons, one predicate: it belongs to a class WITH a lifetime
 * (an outbound call whose moment passed), or it is a session-bound draft. Both
 * are "the context is gone"; neither touches a proposed entity or a merge
 * candidate, which outlive the session by design.
 */
export function diesWithSession(
  proposalType: string,
  targetType: string
): boolean {
  if (proposalLifetimeHours(proposalType, targetType) !== null) return true;
  return isSessionBoundDraft({ targetType, proposalType });
}

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

/**
 * Discard the staged source blobs of proposals this scan just EXPIRED.
 *
 * EXPIRED is terminal and is reached with NO human action at all — the whole
 * point of the scanner — so nothing downstream will ever decide these blobs'
 * fate. This was the dominant leak path: every un-triaged file-carrying
 * proposal orphaned its bytes AND its `documents` row, permanently.
 *
 * `userId: null` says what is true — a scanner has no acting human. The discard
 * door then deletes the document as its OWN owner, reading both the storage key
 * and the deleting principal off the loaded `documents` row, so this can never
 * become a cross-tenant delete. Best-effort per row: one unlucky blob must not
 * abort an expiry pass that has already written its statuses.
 */
async function discardExpiredSourceBlobs(
  expiredIds: string[],
  rows: Array<{ id: string; data: unknown }>
): Promise<void> {
  if (expiredIds.length === 0) return;
  const expired = new Set(expiredIds);
  for (const row of rows) {
    if (!expired.has(row.id)) continue;
    try {
      await discardProposalSourceBlob({
        database: db,
        userId: null,
        proposalData: row.data,
      });
    } catch (err) {
      logger.warn(
        { err, proposalId: row.id },
        "expiry: discarding the staged source blob failed (status already written)"
      );
    }
  }
}

/**
 * GUEST PROPOSALS carry their own clock (Sites W4). A public form's guest
 * submission is stamped `expires_at = filed + retentionDays` by the guest door
 * (`services/forms/guest-submit.ts`), and it is the ONLY proposal population
 * whose `expires_at` this sweeper honours: the actor must be a form actor
 * (`users.agent_type LIKE 'form:%'`, written only by the forms door). Every
 * other row keeps the class-lifetime rule above — the legacy `expires_at`
 * values of the removed default TTL stay inert, as the C2 note requires.
 *
 * Pure half: a row lapses when its `expiresAt` is strictly in the past.
 */
export function selectLapsedGuestIds(
  rows: ReadonlyArray<{ id: string; expiresAt: Date | null }>,
  now: Date
): string[] {
  return rows
    .filter(
      (r) =>
        r.expiresAt instanceof Date && r.expiresAt.getTime() < now.getTime()
    )
    .map((r) => r.id);
}

/** Pending guest proposals whose own expiry passed (query half). */
async function findLapsedGuestProposals(
  now: Date
): Promise<Array<{ id: string; expiresAt: Date | null; data: unknown }>> {
  const formActors = db
    .select({ id: users.id })
    .from(users)
    .where(like(users.agentType, "form:%"));
  const rows = (await db
    .select({
      id: proposals.id,
      expiresAt: proposals.expiresAt,
      data: proposals.data,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.PENDING),
        isNotNull(proposals.expiresAt),
        lt(proposals.expiresAt, now),
        inArray(proposals.agentUserId, formActors)
      )
    )) as Array<{ id: string; expiresAt: Date | null; data: unknown }>;
  return rows;
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
      // Carried ONLY so an expiry can discard a staged source blob — see
      // `discardExpiredSourceBlobs`.
      data: proposals.data,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.PENDING),
        lt(proposals.createdAt, oldestPossiblyLive)
      )
    );

  const lapsed = selectLapsedIds(pending, now);

  // Guest-form proposals past their OWN expiry (see selectLapsedGuestIds). A
  // failure here must not cost the class sweep above its pass: logged, and the
  // guest rows simply wait for the next 6-hourly run.
  let guestRows: Array<{ id: string; expiresAt: Date | null; data: unknown }> =
    [];
  try {
    guestRows = await findLapsedGuestProposals(now);
  } catch (err) {
    logger.warn(
      { err },
      "expiry: guest-proposal scan failed (retried next run)"
    );
  }
  for (const id of selectLapsedGuestIds(guestRows, now)) {
    if (!lapsed.includes(id)) lapsed.push(id);
  }
  const seen = new Set(pending.map((p) => p.id));
  const candidates = [...pending, ...guestRows.filter((g) => !seen.has(g.id))];

  if (lapsed.length === 0) return { scanned: pending.length, expired: 0 };

  // Chunked, and re-asserting PENDING in the WHERE: a human may have approved
  // one of these between the read and the write, and an expiry must never
  // overwrite a real decision.
  const CHUNK = 500;
  let expired = 0;
  /** Ids this scan actually moved to EXPIRED — collected, not fired per chunk. */
  const actionedIds: string[] = [];
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
    for (const r of rows) actionedIds.push(r.id);
    expired += rows.length;
  }

  await discardExpiredSourceBlobs(actionedIds, candidates);

  // Expired = no longer decidable: its bell rows leave with it (one door with
  // approve/reject). ONE write for the whole scan rather than one per chunk —
  // the chunking exists to bound the UPDATE's id list, and there is no reason
  // for the notification write to inherit that bound. The helper no-ops on an
  // empty list, so a scan that expired nothing issues no query at all.
  markProposalNotificationsActioned(actionedIds);

  logger.info(
    { scanned: pending.length, expired },
    "expired lapsed proposals (moment passed, never decided)"
  );
  return { scanned: pending.length, expired };
}

/**
 * Expire a closing session's still-pending proposals whose CONTEXT died with it.
 *
 * The real trigger. Called from `completeSession`, best-effort: a session must
 * close even if this fails, so it never throws.
 *
 * `diesWithSession` decides — classes with a lifetime (ephemeral outbound
 * calls) plus the session-bound drafts (`isSessionBoundDraft`). Closing a session must not discard a
 * proposed entity or a merge candidate that happened to be created during it;
 * those outlive the session by design.
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
        data: proposals.data,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.sessionId, sessionId),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      );

    const ids = pending
      .filter((p) => diesWithSession(p.proposalType, p.targetType))
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
    // Expired = no longer decidable: its bell rows leave with it (one door with approve/reject).
    markProposalNotificationsActioned(rows.map((r) => r.id));
    await discardExpiredSourceBlobs(
      rows.map((r) => r.id),
      pending
    );

    if (rows.length > 0) {
      logger.info(
        { sessionId, expired: rows.length },
        "session closed — expired its unanswered session-bound proposals"
      );
    }
    return rows.length;
  } catch (err) {
    // A lens on the queue is worth less than the session close itself.
    logger.warn({ err, sessionId }, "session-close expiry failed (non-fatal)");
    return 0;
  }
}
