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
 *
 * ONE who, {@link proposalWho}: who decided or ended a request, as the
 * sentence every surface draws beside it ("Decided by Alice", "Withdrawn by
 * Scout"); an expiry names nobody, a failed receipt nobody approved names the
 * agent who asked. Pod admin's history and the browser's lineage read it, so
 * no host keeps its own "ended without a person" list.
 * Pure.
 */

import type { Locale } from "../i18n/index.js";
import { POD_ACTOR_NAME } from "../vocabulary/index.js";
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
 *                     that changed, a cleanup pack with nothing left in it)
 *   app_revoked     — the app that asked was revoked (`revokeApp`)
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
  "app_revoked",
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
  /**
   * The words its author gave, as written (content, not chrome). Only a
   * person or an agent writes here; a helper's reason is the `reason` itself.
   */
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
  /** `reviewedBy` as the pod names it on a display row (read like it). */
  approverName?: string | null;
  reviewedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  /** The session it was filed in: the door of a `session_ended` line. */
  sessionId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
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

/**
 * The English sentences helpers once stored as `withdrawReason`, as if their
 * author wrote them: read as the reason they name, never quoted as anyone's.
 */
const HELPER_WITHDRAW_WORDS: ReadonlyMap<string, ProposalEndReason> = new Map<
  string,
  ProposalEndReason
>([
  ["The app was revoked.", "app_revoked"],
  ["Superseded by a new consent.", "superseded"],
  ["Superseded by a fresher cleanup pack.", "superseded"],
  ["Nothing in it is left to tidy.", "request_changed"],
  ["Replaced by a newer version", "superseded"],
]);

function helperReason(value: unknown): ProposalEndReason | undefined {
  const words = text(value);
  return words ? HELPER_WITHDRAW_WORDS.get(words.trim()) : undefined;
}

/** The old keys, read the way each old helper wrote them. */
function legacyReason(
  status: string,
  data: Record<string, unknown>
): ProposalEndReason {
  if (status === "withdrawn") {
    if (text(data.supersededBy)) return "superseded";
    const helper = helperReason(data.withdrawReason);
    if (helper) return helper;
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

/** Words a person or agent wrote, never a helper's stored sentence. */
function authorWords(value: unknown): string | undefined {
  const words = text(value);
  return words && !helperReason(words) ? words : undefined;
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
    // An app's revoke stamped its sentence as words under `request_changed`
    // before it had a reason of its own: read the reason the words name.
    const stamped = stamp.reason as ProposalEndReason;
    const helper =
      stamped === "request_changed" ? helperReason(stamp.withdrawReason) : undefined;
    return {
      reason: helper ?? stamped,
      by:
        typeof stamp.by === "string" && BY.has(stamp.by)
          ? (stamp.by as ProposalEndedBy)
          : "system",
      at: text(stamp.at) ?? null,
      ...(text(stamp.supersededBy)
        ? { supersededBy: text(stamp.supersededBy) }
        : {}),
      // A helper's sentence stamped as words (app revoke, consent, before
      // they ended with a reason of their own) is never quoted as theirs.
      ...(authorWords(stamp.withdrawReason)
        ? { withdrawReason: authorWords(stamp.withdrawReason) }
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
      ? authorWords(data.withdrawReason)
      : undefined;
  const landedEntityId =
    reason === "record_landed" ? text(data.supersededByEntityId) : undefined;
  return {
    reason,
    by: row.reviewedBy || text(row.approverName) ? "person" : "system",
    at: iso(row.reviewedAt) ?? iso(row.updatedAt),
    ...(supersededBy ? { supersededBy } : {}),
    ...(withdrawReason ? { withdrawReason } : {}),
    ...(landedEntityId ? { landedEntityId } : {}),
  };
}

/** The names a who-line reads, as the pod resolves them on a display row. */
export interface ProposalWhoRow extends ProposalEndedRow {
  /** The agent that filed it. */
  agentActorName?: string | null;
  /** The person who filed it (or the human behind its key). */
  authorName?: string | null;
}

/**
 * The name of who ended a withdrawn request, from the stamp's `by`: the person
 * the pod names as its reviewer, the agent that filed it, or the pod on its
 * own ("Synap"). An author's withdrawal is always its author's, so one with no
 * reviewer (an agent taking its own request back names no person, decision F2)
 * names the agent, never the pod. Null when nothing names them: never a guess.
 */
function endedByName(row: ProposalWhoRow, ended: ProposalEnded): string | null {
  const agent = text(row.agentActorName);
  const approver = text(row.approverName);
  const author = text(row.authorName);
  if (ended.by === "person") return approver ?? author ?? null;
  if (ended.by === "agent" || ended.reason === "author")
    return agent ?? approver ?? author ?? null;
  return POD_ACTOR_NAME;
}

/** The kinds an end line opens: the object routes every host already has. */
export type ProposalEndDoorKind = "proposal" | "entity" | "session" | "track";

/** The one door an end line names, with its words ("Open the newer version"). */
export interface ProposalEndDoor {
  kind: ProposalEndDoorKind;
  id: string;
  label: string;
}

/** The end as a surface draws it: the sentence, and the doors it names. */
export interface ProposalEndLine {
  reason: ProposalEndReason;
  /** The one sentence ("Replaced by a newer version"). */
  text: string;
  /** Open the newer proposal (`superseded`). */
  supersededBy?: string;
  /** Its author's own words, shown as theirs (never a helper's). */
  withdrawReason?: string;
  /** Open the record that already exists (`record_landed`). */
  landedEntityId?: string;
  /** Open the session that ended, or that the agent is already on. */
  sessionId?: string;
  /** Open the goal that ended (`goal_ended`). */
  goalId?: string;
  /**
   * THE door a surface draws beside the line, when the row has its id: the
   * newer version, the record that already exists, the session, the goal.
   */
  door?: ProposalEndDoor;
}

/** The session a session-bound end names: the one it was filed in, else its target. */
function sessionDoor(row: ProposalEndedRow): string | undefined {
  if (row.targetType === "focus_session" && text(row.targetId))
    return text(row.targetId);
  return text(row.sessionId);
}

/**
 * THE end line of a withdrawn or expired proposal, in `locale` (else the
 * ambient catalog locale); null for any other status. An author's withdrawal
 * names who took it back (`row`'s names); a session's, a goal's or a record's
 * end carries the door to it where the row has its id.
 */
export function proposalEndLine(
  row: ProposalWhoRow,
  locale?: Locale
): ProposalEndLine | null {
  const ended = proposalEnded(row);
  if (!ended) return null;
  const t = proposalsT(locale);
  let words: string;
  if (ended.reason === "author") {
    const who = endedByName(row, ended);
    words = who
      ? t("proposals.ended.author", { who })
      : t("proposals.ended.authorUnnamed");
  } else {
    words = t(`proposals.ended.${ended.reason}`);
  }
  const sessionId =
    ended.reason === "session_ended" || ended.reason === "agent_attached"
      ? sessionDoor(row)
      : undefined;
  const goalId =
    ended.reason === "goal_ended"
      ? text(record(record(row.data)?.data)?.goalLoopOf)
      : undefined;
  const target: [ProposalEndDoorKind, string | undefined] = ended.supersededBy
    ? ["proposal", ended.supersededBy]
    : ended.landedEntityId
      ? ["entity", ended.landedEntityId]
      : sessionId
        ? ["session", sessionId]
        : ["track", goalId];
  const door = target[1]
    ? {
        kind: target[0],
        id: target[1],
        label: t(`proposals.ended.door.${target[0]}`),
      }
    : undefined;
  return {
    reason: ended.reason,
    text: words,
    ...(door ? { door } : {}),
    ...(ended.supersededBy ? { supersededBy: ended.supersededBy } : {}),
    ...(ended.withdrawReason ? { withdrawReason: ended.withdrawReason } : {}),
    ...(ended.landedEntityId ? { landedEntityId: ended.landedEntityId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(goalId ? { goalId } : {}),
  };
}

/**
 * What a who-line says:
 *   decided   — a person approved or rejected it ("Decided by Alice")
 *   rule      — a standing rule approved it, nobody reviewed it
 *   withdrawn — who took it back or replaced it ("Withdrawn by Scout")
 *   asked     — a receipt that could not apply, approved by nobody: the agent
 *               (or person) who asked is the only one to name
 */
export type ProposalWhoKind = "decided" | "rule" | "withdrawn" | "asked";

export interface ProposalWho {
  kind: ProposalWhoKind;
  /** Who it names; null for a standing rule. */
  name: string | null;
  /** The one sentence ("Decided by Alice", "Withdrawn by Scout"). */
  text: string;
}

const DECIDED_STATUSES = new Set([
  "approved",
  "auto_approved",
  "rejected",
  "reverted",
  "approval_failed",
  "partially_approved",
]);

/**
 * THE who of a decided or ended request, in `locale` (else the ambient
 * catalog locale): "Decided by {person}" for a person's decision, "Approved
 * by a standing rule" for an auto-approved write, "Withdrawn by {who}" (the
 * stamp's `by`, legacy rows from their review columns), and on a receipt that
 * could not apply with no person behind it, "Asked by {agent}". Null when it
 * names nobody: pending, an expiry (its moment passed: the chip and the end
 * line say it all), or a decision whose person was not read.
 */
export function proposalWho(
  row: ProposalWhoRow,
  locale?: Locale
): ProposalWho | null {
  const status = (row.status ?? "").trim().toLowerCase();
  const t = proposalsT(locale);
  if (status === "withdrawn") {
    const ended = proposalEnded(row);
    const name = ended ? endedByName(row, ended) : null;
    return name
      ? { kind: "withdrawn", name, text: t("proposals.who.withdrawn", { who: name }) }
      : null;
  }
  if (!DECIDED_STATUSES.has(status)) return null;
  const approver = text(row.approverName);
  if (approver)
    return {
      kind: "decided",
      name: approver,
      text: t("proposals.who.decided", { who: approver }),
    };
  if (status === "auto_approved")
    return { kind: "rule", name: null, text: t("proposals.who.rule") };
  if (status === "approval_failed") {
    const asker = text(row.agentActorName) ?? text(row.authorName);
    return asker
      ? { kind: "asked", name: asker, text: t("proposals.who.asked", { who: asker }) }
      : null;
  }
  return null;
}

/** One item a failed plan applied and could not roll back. */
export interface ProposalItemLeft {
  /** What it is: `entity`, `document`, `session`, `relation`, ... */
  kind: string;
  id: string;
}

/**
 * The items a failed connected plan applied and could NOT roll back
 * (`data.planFailure.compensation.notCompensated`): they are live, so "nothing
 * was applied" would be false. Empty for every other row.
 */
export function proposalItemsLeft(data: unknown): ProposalItemLeft[] {
  const left = record(record(record(data)?.planFailure)?.compensation)
    ?.notCompensated;
  if (!Array.isArray(left)) return [];
  return left.flatMap((item) => {
    const r = record(item);
    const kind = text(r?.kind);
    const id = text(r?.id);
    return kind && id ? [{ kind, id }] : [];
  });
}
