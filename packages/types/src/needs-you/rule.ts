/**
 * THE NEEDS-YOU RULE: what really needs the person, and where everything
 * else goes (plan v4 decision E, founder 2026-10-27, all six parts; spec
 * `needs-truth` §4).
 *
 *   needs you = an open request that only you can settle, raised by a real
 *   asker (an agent, or a commitment gate), not yet answered, on work that is
 *   live (an agent moved in the last 7 days and is not working right now),
 *   and either under 7 days old or a commitment.
 *
 * The census of 2026-10-26 counted 114 items claiming the founder. 7 needed
 * them. The other 107 were not lies one by one: each was an owed slot, or a
 * pending proposal, read by a predicate that never asked who raised it,
 * whether anyone still works on it, or whether anything waits on it.
 *
 * EVERY FAILED CLAUSE LANDS IN A NAMED FOLD, never dropped:
 *
 *   `from_system`       — no real asker: a criterion escalation, a missing
 *                         param, a run's "keep going", a decision ask no agent
 *                         filed. The producer should not have asked the person
 *                         (decision E3); until it stops, the row is kept apart.
 *   `stopped`           — no agent moved the session for 7 days, or it ended.
 *                         ONE row per session: "Resume or close" (E1).
 *   `working`           — an agent is on it right now: "asks you when you
 *                         can" (E2). Derived from live state, no agent flag.
 *   `review_later`      — a real ask, owed more than 7 days, not a commitment.
 *   `changes_to_review` — a pending proposal nothing waits on: bookkeeping,
 *                         batch-approved, its own count (E6).
 *
 * The clauses are evaluated in the census precedence (machine > stopped >
 * working > age), so one row has exactly one class.
 *
 * ── THE SQL TWIN ────────────────────────────────────────────────────────────
 * `needsYouSlotClassSql` (`@synap/database`, `needs-you-predicate.ts`) is this
 * rule in SQL, for the reapers (jobs cannot import api) and the counts. The
 * PGlite parity test there runs every fixture through both. Two choices make
 * the twins provably equal instead of nearly equal:
 *   - `owedSince` is compared as TEXT, and only in the canonical
 *     `toISOString()` form the server stamps (`ISO_STAMP`). Anything else
 *     cannot age into Review later (fails toward keeping, as `askFate` does)
 *     and can never make a SQL cast throw on a row written around the doors.
 *   - JSON fields are read by their JSON TYPE (`askCause.kind` a string,
 *     `askedBy` a non-empty string, `pendingRelay` an object), never by
 *     JavaScript truthiness, which SQL cannot spell.
 *
 * "Last agent activity" is MEASURED from agent evidence (agent room posts,
 * chat turns, agent-filed proposals, agent-attributed events), never
 * `updatedAt`: any unrelated write moves that (a backfill made 8-day-old
 * machine asks rank as fresh, census §2).
 *
 * Pure, no I/O: the clock is a parameter.
 */

import { deliverableOwedBy } from "../units/deliverable.js";
import { REVIEW_LATER_AFTER_MS } from "../proposals/fate.js";
import type { ProposalWaits } from "../proposals/fate.js";
import { SESSION_WORKING_WINDOW_MS } from "../run-activity/live.js";

// ─── Constants (the SQL twin composes these, never a copy) ──────────────────

/** No agent evidence for this long ⇒ the session is Stopped (E1). */
export const NEEDS_YOU_STOPPED_AFTER_DAYS = 7;
export const NEEDS_YOU_STOPPED_AFTER_MS =
  NEEDS_YOU_STOPPED_AFTER_DAYS * 24 * 3_600_000;

/** A real ask owed longer than this leaves the headline (Resolve-XP decision 3). */
export const NEEDS_YOU_REVIEW_LATER_AFTER_MS = REVIEW_LATER_AFTER_MS;

/** Agent evidence this recent (or a turn in flight) ⇒ Working (D1's window). */
export const NEEDS_YOU_WORKING_WINDOW_MS = SESSION_WORKING_WINDOW_MS;

/**
 * Session statuses whose work can still move. Mirrors `OPEN_SESSION_STATUSES`
 * (`@synap/database`); the parity test runs every status through both twins.
 */
export const NEEDS_YOU_OPEN_SESSION_STATUSES = [
  "active",
  "paused",
  "stale",
] as const;

/**
 * Causes a real asker stands behind without an agent stamp: the session's own
 * plan/deploy gate, and an external agent's approval request. Every other
 * cause (`run`, `param`, `criterion`, a `decision` no agent filed) is the
 * system asking on nobody's behalf.
 */
export const NEEDS_YOU_ASKER_CAUSES = ["gate", "external_approval"] as const;

/**
 * The ONE stamp shape `owedSince` is aged by: `Date.prototype.toISOString()`,
 * which every server door writes (`reconcileOwedSince`). Text-comparable, and
 * the SQL twin reads it by the same pattern (POSIX classes, no `\d`).
 */
export const ISO_STAMP_PATTERN =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";
const ISO_STAMP = new RegExp(ISO_STAMP_PATTERN);

// ─── Classes and folds ──────────────────────────────────────────────────────

/** Where one owed ask lands. */
export const NEEDS_YOU_SLOT_CLASSES = [
  "needs_you",
  "from_system",
  "stopped",
  "working",
  "review_later",
] as const;
export type NeedsYouSlotClass = (typeof NEEDS_YOU_SLOT_CLASSES)[number];

/** Where one pending proposal lands. */
export const NEEDS_YOU_PROPOSAL_CLASSES = [
  "needs_you",
  "review_later",
  "changes_to_review",
] as const;
export type NeedsYouProposalClass = (typeof NEEDS_YOU_PROPOSAL_CLASSES)[number];

/** Every class a row can carry — one vocabulary across slots and proposals. */
export type NeedsYouClass = NeedsYouSlotClass | NeedsYouProposalClass;

/** The folds beside the headline, in the order a surface draws them. */
export const NEEDS_YOU_FOLDS = [
  "working",
  "stopped",
  "review_later",
  "from_system",
  "changes_to_review",
] as const;
export type NeedsYouFold = (typeof NEEDS_YOU_FOLDS)[number];

// ─── Slot facts ─────────────────────────────────────────────────────────────

/** The stored slot fields the rule reads — structural, `ExpectedOutput` fits. */
export interface NeedsYouSlotFacts {
  owner?: unknown;
  status?: unknown;
  retiredAt?: unknown;
  optional?: unknown;
  owedSince?: unknown;
  askedBy?: unknown;
  askCause?: unknown;
  criterionKey?: unknown;
  paramName?: unknown;
  pendingRelay?: unknown;
  ask?: unknown;
}

/** The session facts the rule reads, measured by the pod in one batched read. */
export interface NeedsYouSessionFacts {
  status: string;
  /** An IS turn is running in the session's room right now. */
  turnInFlight: boolean;
  /**
   * The newest AGENT evidence: an agent room post, a chat turn, an
   * agent-filed proposal, an agent-attributed event. `null` = none yet.
   * Never `updatedAt`.
   */
  lastAgentActivityAt: Date | string | null;
  /** The floor for a session no agent has touched yet. */
  startedAt: Date | string | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

function timeOf(v: Date | string | null | undefined): number | null {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Still owed by the person: THE deliverable rule (`OWED_SLOT_CLAUSES` in SQL). */
function isOwed(slot: NeedsYouSlotFacts): boolean {
  return (
    deliverableOwedBy(slot as Parameters<typeof deliverableOwedBy>[0]) === "you"
  );
}

/**
 * What raised the ask, read off the slot: the stamped `askCause.kind`, else a
 * criterion or param slot's own key. `effectiveAskCause`'s reading, by JSON
 * type. `null` when nothing names a cause.
 */
export function needsYouAskCauseKind(slot: NeedsYouSlotFacts): string | null {
  if (isObject(slot.askCause) && typeof slot.askCause.kind === "string") {
    return slot.askCause.kind;
  }
  if (nonEmptyString(slot.criterionKey)) return "criterion";
  if (nonEmptyString(slot.paramName)) return "param";
  return null;
}

/**
 * Was it raised by a real asker? An agent (`askedBy`), the session's gate, an
 * external agent's approval request, or a decision ask an AGENT filed (W6b's
 * agent-author rule). A slot with no stamp at all reads as asked: it predates
 * the stamps (W6a), and every door that wrote one then was an agent's.
 */
export function needsYouHasRealAsker(slot: NeedsYouSlotFacts): boolean {
  const cause = needsYouAskCauseKind(slot);
  if (cause === null) return true;
  if ((NEEDS_YOU_ASKER_CAUSES as readonly string[]).includes(cause)) {
    return true;
  }
  return cause === "decision" && nonEmptyString(slot.askedBy);
}

/**
 * Does answering commit the person (`effectiveAskStakes`)? A gate and a
 * relayed answer waiting for the tap are FORCED commitments; the ask raises
 * them (`stakes: commitment`, a secret `provide`). A commitment never ages
 * into Review later.
 */
export function needsYouIsCommitment(slot: NeedsYouSlotFacts): boolean {
  if (needsYouAskCauseKind(slot) === "gate") return true;
  if (isObject(slot.pendingRelay)) return true;
  const ask = slot.ask;
  if (!isObject(ask)) return false;
  if (ask.stakes === "commitment") return true;
  return (
    ask.mode === "provide" &&
    isObject(ask.provide) &&
    ask.provide.kind === "secret"
  );
}

/** The canonical stamp, or `null` when the slot carries none (never aged). */
function owedStamp(slot: NeedsYouSlotFacts): string | null {
  return typeof slot.owedSince === "string" && ISO_STAMP.test(slot.owedSince)
    ? slot.owedSince
    : null;
}

/** Where the SESSION stands, for every ask it holds. */
export type NeedsYouSessionClass = "stopped" | "working" | "live";

/**
 * Stopped (ended, or no agent evidence for 7 days, the start counting as
 * evidence), working (a turn in flight, or agent evidence inside the working
 * window), else live.
 */
export function needsYouSessionClass(
  session: NeedsYouSessionFacts,
  now: Date | number = Date.now()
): NeedsYouSessionClass {
  const at = now instanceof Date ? now.getTime() : now;
  if (
    !(NEEDS_YOU_OPEN_SESSION_STATUSES as readonly string[]).includes(
      session.status
    )
  ) {
    return "stopped";
  }
  const agent = timeOf(session.lastAgentActivityAt);
  const started = timeOf(session.startedAt);
  const moved =
    agent === null
      ? started
      : started === null
        ? agent
        : Math.max(agent, started);
  if (moved === null || moved < at - NEEDS_YOU_STOPPED_AFTER_MS) {
    return "stopped";
  }
  if (session.turnInFlight) return "working";
  if (agent !== null && agent >= at - NEEDS_YOU_WORKING_WINDOW_MS) {
    return "working";
  }
  return "live";
}

/**
 * THE rule for one slot on its session. `null` when the slot is not owed by
 * the person at all (done, retired, optional, the agent's): it is in no list.
 */
export function classifyOwedAsk(
  slot: NeedsYouSlotFacts,
  session: NeedsYouSessionFacts,
  now: Date | number = Date.now()
): NeedsYouSlotClass | null {
  if (!isOwed(slot)) return null;
  if (!needsYouHasRealAsker(slot)) return "from_system";
  const at = now instanceof Date ? now.getTime() : now;
  const live = needsYouSessionClass(session, at);
  if (live === "stopped") return "stopped";
  if (live === "working") return "working";
  const stamp = owedStamp(slot);
  if (
    stamp !== null &&
    !needsYouIsCommitment(slot) &&
    stamp < new Date(at - NEEDS_YOU_REVIEW_LATER_AFTER_MS).toISOString()
  ) {
    return "review_later";
  }
  return "needs_you";
}

// ─── Proposals ──────────────────────────────────────────────────────────────

/** The pending proposal facts the rule reads. */
export interface NeedsYouProposalFacts {
  status: string;
  createdAt: Date | string;
  /** W3 `waitsOnIt` (`resolveProposalWaits`): a gate, an owed slot, a parked run. */
  waits: ProposalWaits;
  /** The session it was filed in; `null` when filed outside one. */
  sessionId: string | null;
  /**
   * That session's status, when the reader may read it. `null` with a
   * `sessionId` = unreadable, which reads as open: a proposal is never
   * demoted on a session nobody let us see.
   */
  sessionStatus: string | null;
}

/**
 * THE rule for one pending proposal. Needs you only when something WAITS on
 * it (a gate, an owed slot, a parked run) on work that is still open. A gate
 * is a commitment and never ages; any other wait over 7 days goes to Review
 * later. Every other pending proposal is a change to review. `null` when it
 * is not pending.
 */
export function classifyPendingProposal(
  p: NeedsYouProposalFacts,
  now: Date | number = Date.now()
): NeedsYouProposalClass | null {
  if (p.status !== "pending") return null;
  if (!p.waits.waits) return "changes_to_review";
  if (
    p.sessionId !== null &&
    p.sessionStatus !== null &&
    !(NEEDS_YOU_OPEN_SESSION_STATUSES as readonly string[]).includes(
      p.sessionStatus
    )
  ) {
    return "changes_to_review";
  }
  if (p.waits.reason !== "gate") {
    const at = now instanceof Date ? now.getTime() : now;
    const created = timeOf(p.createdAt);
    if (created !== null && created < at - NEEDS_YOU_REVIEW_LATER_AFTER_MS) {
      return "review_later";
    }
  }
  return "needs_you";
}

// ─── Folding: one number, one source ────────────────────────────────────────

/** A classified row, as the folds count it. */
export interface NeedsYouClassifiedRow {
  needsYouClass: NeedsYouClass;
  /** The session the row belongs to, if any — Stopped counts sessions too. */
  sessionId?: string | null;
}

/** The headline and every fold, counted over the SAME rows a list draws. */
export interface NeedsYouFoldCounts {
  /** The headline: rows that really need the person. */
  needsYou: number;
  working: number;
  /** Stopped rows… */
  stopped: number;
  /** …on this many sessions (Stopped draws one row per session). */
  stoppedSessions: number;
  reviewLater: number;
  fromSystem: number;
  changesToReview: number;
}

/** Count rows by class. Pure; the readers' count IS this over their rows. */
export function foldNeedsYouCounts(
  rows: readonly NeedsYouClassifiedRow[]
): NeedsYouFoldCounts {
  const counts: NeedsYouFoldCounts = {
    needsYou: 0,
    working: 0,
    stopped: 0,
    stoppedSessions: 0,
    reviewLater: 0,
    fromSystem: 0,
    changesToReview: 0,
  };
  const stoppedSessions = new Set<string>();
  for (const row of rows) {
    switch (row.needsYouClass) {
      case "needs_you":
        counts.needsYou += 1;
        break;
      case "working":
        counts.working += 1;
        break;
      case "stopped":
        counts.stopped += 1;
        if (row.sessionId) stoppedSessions.add(row.sessionId);
        break;
      case "review_later":
        counts.reviewLater += 1;
        break;
      case "from_system":
        counts.fromSystem += 1;
        break;
      case "changes_to_review":
        counts.changesToReview += 1;
        break;
    }
  }
  counts.stoppedSessions = stoppedSessions.size;
  return counts;
}

/** Is this row in the headline? The ONE membership test. */
export function isNeedsYou(row: NeedsYouClassifiedRow): boolean {
  return row.needsYouClass === "needs_you";
}
