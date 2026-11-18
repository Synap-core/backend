/**
 * HOW A PROPOSAL ENDED with nobody deciding it (plan 8032a127 D6): withdrawn
 * (its author took it back, or a newer filing replaced it) or expired (its
 * moment passed). The status says THAT it ended; the end reason says WHY.
 *
 * ONE stamp, `data.ended` ({@link ProposalEndedStamp}), written by the status
 * door (`transitionProposal`, database) on every move to `withdrawn` or
 * `expired`, so no end path can forget it. Before it, six ad hoc keys said
 * why (`expiredBy`, `expiredByCleanupPack`, `supersededBy`, `withdrawReason`,
 * `closedByMessageId`, `withdrawnReason`); a row written before the stamp is
 * read from them ({@link proposalEnded}), with no migration.
 *
 * ONE line, {@link proposalEndLine}: the sentence every surface draws under the
 * status chip ("Replaced by a newer version", "The record already exists").
 * The chip itself stays `resolveStatusLabel`: an end reason is not a status.
 * Pure.
 */

import type { Locale } from "../i18n/index.js";
import { proposalsT } from "./copy.js";

/**
 * Why it ended. Each names the helper that writes it:
 *   superseded      — a newer filing replaced it (`insertPendingProposal`'s
 *                     supersede, `endReplacedProposal`, a fresher cleanup pack)
 *   author          — its author took it back (`proposals.withdraw`)
 *   record_landed   — the record it would create exists (`expirePendingCreatesOfLandedRecord`)
 *   session_ended   — its job ended (session close, stage gates of an ended run)
 *   goal_ended      — its goal ended (`goal-end.ts`)
 *   lapsed          — its moment passed (the class-lifetime sweep)
 *   lifecycle_move  — a person's move made it stale (`expireProposalsStaleAfterMove`)
 *   agent_attached  — the agent it hands work to is already on the job
 *   cleanup_pack    — a cleanup pack the person approved expired it
 *   sent_outside    — the person sent the message from the provider itself
 *   request_changed — the requester no longer asks for it (a scope request
 *                     that changed, an app that was revoked)
 */
export const PROPOSAL_END_REASONS = [
  "superseded",
  "author",
  "record_landed",
  "session_ended",
  "goal_ended",
  "lapsed",
  "lifecycle_move",
  "agent_attached",
  "cleanup_pack",
  "sent_outside",
  "request_changed",
] as const;
export type ProposalEndReason = (typeof PROPOSAL_END_REASONS)[number];

/** Who ended it: a person, an agent, or the pod on its own (a sweep). */
export type ProposalEndedBy = "person" | "agent" | "system";

/** The key the stamp lives under in `proposals.data`. */
export const PROPOSAL_ENDED_KEY = "ended" as const;

/** The one stamp, as stored. */
export interface ProposalEndedStamp {
  reason: ProposalEndReason;
  by: ProposalEndedBy;
  /** ISO time of the end. */
  at: string;
  /** The proposal that replaced it (`superseded`). */
  supersededBy?: string;
  /** The words its author or the helper gave, as written (content, not chrome). */
  withdrawReason?: string;
  /** The record that already exists (`record_landed`). */
  landedEntityId?: string;
}

/** What a helper hands the door: the door adds `by` and `at`. */
export type ProposalEndedInput = Omit<ProposalEndedStamp, "by" | "at">;

/** How it ended, as read: `at` is null on an old row that never said when. */
export interface ProposalEnded extends Omit<ProposalEndedStamp, "at"> {
  at: string | null;
}

/** The row fields the read uses; every one is on a display row. */
export interface ProposalEndedRow {
  status?: string | null;
  data?: unknown;
  reviewedBy?: string | null;
  reviewedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

const END_STATUSES = new Set(["withdrawn", "expired"]);
const REASONS = new Set<string>(PROPOSAL_END_REASONS);
const BY = new Set<string>(["person", "agent", "system"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  return text(value) ?? null;
}

/** The old keys, read the way each old helper wrote them. */
function legacyReason(
  status: string,
  data: Record<string, unknown>
): ProposalEndReason {
  if (status === "withdrawn") {
    if (text(data.supersededBy)) return "superseded";
    if (text(data.closedByMessageId)) return "sent_outside";
    if (data.withdrawnReason === "scope_request_changed")
      return "request_changed";
    return "author";
  }
  const expiredBy = data.expiredBy;
  if (
    expiredBy === "record_landed" ||
    expiredBy === "session_ended" ||
    expiredBy === "lifecycle_move" ||
    expiredBy === "agent_attached"
  ) {
    return expiredBy;
  }
  if (text(data.expiredByCleanupPack)) return "cleanup_pack";
  if (text(record(data.data)?.goalLoopOf)) return "goal_ended";
  return "lapsed";
}

/**
 * How a withdrawn or expired proposal ended, or null for any other status.
 * The stamp when the row has one; else derived from the keys the helpers
 * wrote before it (never null for an ended row: an unknown expiry is
 * `lapsed`, an unknown withdrawal its author's).
 */
export function proposalEnded(row: ProposalEndedRow): ProposalEnded | null {
  const status = (row.status ?? "").trim().toLowerCase();
  if (!END_STATUSES.has(status)) return null;
  const data = record(row.data) ?? {};
  const stamp = record(data.ended);
  if (stamp && typeof stamp.reason === "string" && REASONS.has(stamp.reason)) {
    return {
      reason: stamp.reason as ProposalEndReason,
      by:
        typeof stamp.by === "string" && BY.has(stamp.by)
          ? (stamp.by as ProposalEndedBy)
          : "system",
      at: text(stamp.at) ?? null,
      ...(text(stamp.supersededBy)
        ? { supersededBy: text(stamp.supersededBy) }
        : {}),
      ...(text(stamp.withdrawReason)
        ? { withdrawReason: text(stamp.withdrawReason) }
        : {}),
      ...(text(stamp.landedEntityId)
        ? { landedEntityId: text(stamp.landedEntityId) }
        : {}),
    };
  }
  const reason = legacyReason(status, data);
  const supersededBy =
    reason === "superseded" ? text(data.supersededBy) : undefined;
  // Only an author's or a requester's own words; the other helpers wrote their
  // own English sentence there, which the end line now says in its place.
  const withdrawReason =
    reason === "author" || reason === "request_changed"
      ? text(data.withdrawReason)
      : undefined;
  const landedEntityId =
    reason === "record_landed" ? text(data.supersededByEntityId) : undefined;
  return {
    reason,
    by: row.reviewedBy ? "person" : "system",
    at: iso(row.reviewedAt) ?? iso(row.updatedAt),
    ...(supersededBy ? { supersededBy } : {}),
    ...(withdrawReason ? { withdrawReason } : {}),
    ...(landedEntityId ? { landedEntityId } : {}),
  };
}

/** The end as a surface draws it: the sentence, and the doors it names. */
export interface ProposalEndLine {
  reason: ProposalEndReason;
  /** The one sentence ("Replaced by a newer version"). */
  text: string;
  /** Open the newer proposal (`superseded`). */
  supersededBy?: string;
  /** The author's or the helper's own words, shown as theirs. */
  withdrawReason?: string;
  /** Open the record that already exists (`record_landed`). */
  landedEntityId?: string;
}

/**
 * THE end line of a withdrawn or expired proposal, in `locale` (else the
 * ambient catalog locale); null for any other status.
 */
export function proposalEndLine(
  row: ProposalEndedRow,
  locale?: Locale
): ProposalEndLine | null {
  const ended = proposalEnded(row);
  if (!ended) return null;
  return {
    reason: ended.reason,
    text: proposalsT(locale)(`proposals.ended.${ended.reason}`),
    ...(ended.supersededBy ? { supersededBy: ended.supersededBy } : {}),
    ...(ended.withdrawReason ? { withdrawReason: ended.withdrawReason } : {}),
    ...(ended.landedEntityId ? { landedEntityId: ended.landedEntityId } : {}),
  };
}
