/**
 * A pending proposal's FATE ON SILENCE — what happens if nobody decides it
 * (pod doc 86890dee). Declared the moment it is born so nothing piles up
 * silently: every surface reads it from the wire (the read doors stamp it on
 * the display row) and draws one sentence (`proposalFateLine`, `../lens/rows.ts`).
 * Pure; it encodes the pod's existing sweeps, it does not add one.
 */

import { isDocumentEditProposal } from "./intent.js";
import type { UnitTone } from "../units/state.js";

/**
 * Untouched `objectWork` proposals leave the headline count after this many
 * days and wait in "Review later" (founder, 2026-10-26). They never expire.
 * The needs-you "Older" fold reads the same clock (`OLDER_AFTER_MS`, api
 * `needs-you-union.ts`).
 */
export const REVIEW_LATER_AFTER_DAYS = 7;
export const REVIEW_LATER_AFTER_MS = REVIEW_LATER_AFTER_DAYS * 24 * 3_600_000;

/**
 * SESSION-BOUND DRAFTS: document edits die when their session closes (the
 * pod's close sweep, api `expire-lapsed-proposals.ts`, which re-exports this).
 * Here so the browser's close moment reads the same predicate from types
 * instead of re-deriving it.
 */
export const isSessionBoundDraft = isDocumentEditProposal;

/**
 *   `expires`          — an ephemeral ask with a lifetime: lapses at
 *                        `expiresAt`. `orSessionEnd` when it is bound to a
 *                        session too: closing the session retires it as well,
 *                        so it goes at the EARLIER of the two.
 *   `dies_with_session` — a session-bound draft: retired when its session ends.
 *   `review_later`     — objectWork untouched for 7 days: out of the headline
 *                        count, kept in the Review later pile `since` then.
 *   `until_decided`    — waits for a decision, with no deadline.
 */
export type ProposalFate =
  | { kind: "expires"; expiresAt: string; orSessionEnd: boolean }
  | { kind: "dies_with_session" }
  | { kind: "until_decided" }
  | { kind: "review_later"; since: string };

export type ProposalFateKind = ProposalFate["kind"];

/** What the fate reads — every field already on a display row. */
export interface ProposalFateInput {
  /** `proposalClassFields().class` (api) — objectWork | ephemeral | curatorial | governance | access. */
  proposalClass: string | null | undefined;
  /** `proposalClassFields().lifetimeHours` — null = the class never expires. */
  lifetimeHours: number | null | undefined;
  createdAt: string | Date;
  targetType: string | null | undefined;
  proposalType: string | null | undefined;
  /** The session it was filed in; null when filed outside one. */
  sessionId: string | null | undefined;
  now: Date | number;
}

function time(at: string | Date): number {
  return at instanceof Date ? at.getTime() : Date.parse(at);
}

/**
 * THE fate rule. Order is the rule:
 *  1. A lifetime (the server's class table) → `expires`, and `orSessionEnd`
 *     when it has a session (`diesWithSession`'s first arm).
 *  2. A session-bound draft WITH a session → `dies_with_session`.
 *  3. `objectWork` older than {@link REVIEW_LATER_AFTER_DAYS} → `review_later`.
 *  4. Everything else → `until_decided`.
 * An unreadable `createdAt` fails toward KEEPING: no clock is started from it.
 */
export function proposalFate(input: ProposalFateInput): ProposalFate {
  const created = time(input.createdAt);
  const readable = Number.isFinite(created);
  const hasSession = Boolean(input.sessionId);
  const lifetime = input.lifetimeHours;
  if (lifetime != null && Number.isFinite(lifetime) && readable) {
    return {
      kind: "expires",
      expiresAt: new Date(created + lifetime * 3_600_000).toISOString(),
      orSessionEnd: hasSession,
    };
  }
  if (hasSession && isSessionBoundDraft(input)) {
    return { kind: "dies_with_session" };
  }
  if (input.proposalClass === "objectWork" && readable) {
    const since = created + REVIEW_LATER_AFTER_MS;
    const now = input.now instanceof Date ? input.now.getTime() : input.now;
    if (now > since) {
      return { kind: "review_later", since: new Date(since).toISOString() };
    }
  }
  return { kind: "until_decided" };
}

/**
 * Is this proposal in the Review later pile? The ONE predicate for every
 * count (needs-you, orient's pendingReview) — a pglite test pins its SQL twin to it.
 */
export function isReviewLater(input: ProposalFateInput): boolean {
  return proposalFate(input).kind === "review_later";
}

/**
 * The fate sentences, ONCE for a pending proposal (`proposalFateLine`,
 * `../lens/rows.ts`) and an owed ask (`askCardView`, `../ask/card.ts`): one
 * fate reads one way in both families, side by side on one list. Copy, not
 * vocabulary: no fate kind is a stored value.
 */
export const FATE_COPY = {
  untilDecided: "Stays until you decide",
  /** A session-bound draft, or an agent's own confirm / choose. */
  endsWithSession: "Ends with the session",
  reviewLater: "In Review later",
  /** `date` is already formatted ("29 Sep"). */
  reviewLaterSince: (date: string): string => `In Review later since ${date}`,
  /** The fold's own label, with how many rows it holds. */
  reviewLaterFold: (count: number): string => `Review later · ${count}`,
  /** An expiry its session's end may come before. */
  orSessionEnd: (expiry: string): string =>
    `${expiry}, or when the session ends`,
} as const;

/**
 * The fate's tone. Amber only for a real deadline (`expires`): every other
 * fate keeps the item, or ends it quietly with its session, and an amber mark
 * on most cards would stop meaning "act soon".
 */
export const FATE_TONE: Record<ProposalFateKind, UnitTone> = {
  expires: "warning",
  dies_with_session: "textMuted",
  until_decided: "textMuted",
  review_later: "textMuted",
};

/**
 * Does an agent WAIT on this proposal (`waitsOnIt`)?
 *   `gate`       — it is an awaited plan/deploy gate (`AWAITED_GATE_PROPOSAL_TYPES`).
 *   `owed_slot`  — it fills a slot the session owes.
 *   `parked_run` — its session's run is parked `waiting_on_you`.
 */
export const PROPOSAL_WAIT_REASONS = ["gate", "owed_slot", "parked_run"] as const;
export type ProposalWaitReason = (typeof PROPOSAL_WAIT_REASONS)[number];

export interface ProposalWaits {
  waits: boolean;
  /** Present only when `waits`. */
  reason?: ProposalWaitReason;
}
