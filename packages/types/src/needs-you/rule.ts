/**
 * THE NEEDS-YOU RULE: what really needs the person, and where everything
 * else goes (plan v4 decision E, founder 2026-10-27, all six parts; spec
 * `needs-truth` §4).
 *
 *   needs you = an open request that only you can settle, raised by a real
 *   asker, not yet answered, on work that is live (an agent moved in the last
 *   7 days and is not working right now), and either under 7 days old or a
 *   commitment.
 *
 * Every owed slot and every pending proposal used to claim the person. The
 * predicate never asked who raised it, whether anyone still works on it, or
 * whether anything waits on it.
 *
 * EVERY FAILED CLAUSE LANDS IN A NAMED FOLD, never dropped:
 *
 *   `from_system`       — no real asker: a decision ask no agent filed. Every
 *                         other cause stands for someone: a criterion grade
 *                         the evaluating agent escalated, a run its launcher
 *                         attends, a param the person's own run lacks, a gate.
 *   `stopped`           — the agent's own question (a confirm / choose that
 *                         ends with its session) on work no agent moved for 7
 *                         days, or that ended. ONE row per session: "Resume
 *                         or close" (E1). A person deliverable (act, provide,
 *                         form, plain work, a criterion grade) is never
 *                         Stopped: it is still the person's to do, whatever
 *                         became of the agent, and closing never retires it.
 *   `working`           — an agent is on it right now: "asks you when you
 *                         can" (E2). Derived from live state, no agent flag.
 *                         A pending proposal on that session waits there too,
 *                         unless a gate waits on it (F2).
 *   `review_later`      — a real ask, owed more than 7 days, not a commitment.
 *   `changes_to_review` — a pending proposal nothing waits on: bookkeeping,
 *                         batch-approved, its own count (E6).
 *
 * The clauses are evaluated in one precedence (machine > stopped > working >
 * age), so one row has exactly one class. "Ended" is the terminal set
 * (`TERMINAL_SESSION_STATUSES`): a forming or scheduled session is not ended.
 *
 * ── THE SQL TWIN ────────────────────────────────────────────────────────────
 * `needsYouSlotClassSql` (`@synap/database`, `needs-you-predicate.ts`) is this
 * rule in SQL, for the reapers (jobs cannot import api). The PGlite parity
 * test there runs every fixture through both. Two choices make
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
 * machine asks rank as fresh).
 *
 * Pure, no I/O: the clock is a parameter.
 */

// The zod-free leaf, never `../ask/card.js` (which reads zod through
// `../ask/index.js`): this rule is in the graph of the `connections` leaf
// that relay loads (guard: `relay-leaves.bare-free.test.ts`).
import { askEndsWithSession } from "../ask/ends-with-session.js";
import type { AskCardSlot } from "../ask/card.js";
import { TERMINAL_SESSION_STATUSES } from "../focus-sessions/statuses.js";
import { deliverableOwedBy } from "../units/deliverable.js";
import { REVIEW_LATER_AFTER_MS } from "../proposals/fate.js";
import type { ProposalWaits } from "../proposals/fate.js";
import { SESSION_WORKING_WINDOW_MS } from "../run-activity/live.js";
import { WORK_CLOCK } from "../work-clock/index.js";

// ─── Constants (the SQL twin composes these, never a copy) ──────────────────

/** No agent evidence for 7 days ⇒ the session is Stopped (E1). */
export const NEEDS_YOU_STOPPED_AFTER_MS = WORK_CLOCK.stuck;

/** A real ask owed longer than this leaves the headline (Resolve-XP decision 3). */
export const NEEDS_YOU_REVIEW_LATER_AFTER_MS = REVIEW_LATER_AFTER_MS;

/** Agent evidence this recent (or a turn in flight) ⇒ Working (D1's window). */
export const NEEDS_YOU_WORKING_WINDOW_MS = SESSION_WORKING_WINDOW_MS;

/**
 * Session statuses that ENDED the work: the terminal set, never "not in some
 * open list" (a forming or scheduled session has not ended). The SQL twin
 * reads this list; the parity test runs every status through both.
 */
export const NEEDS_YOU_ENDED_SESSION_STATUSES = TERMINAL_SESSION_STATUSES;

function sessionEnded(status: string | null): boolean {
  return (
    status !== null &&
    (NEEDS_YOU_ENDED_SESSION_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * The agent evidence that is the ASKING itself, never work: the room post
 * that poses a question (`roomPost.kind = 'question'`) and the `slot_asked`
 * event its ask logs. An agent that asks and stops is not "working" — its
 * question is the person's (decision E2: "unless the agent stopped on it").
 * Both still count as the agent having MOVED the session (Stopped's clock).
 * Mirrors api `FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE` (pinned by a test there).
 */
export const NEEDS_YOU_ASKING_EVENT_TYPES = [
  "focus_session.slot_asked.completed",
] as const;
export const NEEDS_YOU_QUESTION_POST_KIND = "question";

/**
 * Causes that are a real ask only when an AGENT filed them (`askedBy`): a
 * decision ask with no agent behind it is the system asking on nobody's
 * behalf (W6b's agent-author rule). Every other cause stands for its asker
 * without a stamp: the session's gate, an external agent's approval request,
 * a criterion grade (the evaluating agent's escalation), a run's "keep going"
 * (its launcher's run) and a missing param (the person's own run). The
 * producers that asked for them on nobody's behalf were removed (be#295).
 */
export const NEEDS_YOU_AGENT_FILED_CAUSES = ["decision"] as const;

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
const NEEDS_YOU_SLOT_CLASSES = [
  "needs_you",
  "from_system",
  "stopped",
  "working",
  "review_later",
] as const;
export type NeedsYouSlotClass = (typeof NEEDS_YOU_SLOT_CLASSES)[number];

/** Where one pending proposal lands. */
const NEEDS_YOU_PROPOSAL_CLASSES = [
  "needs_you",
  "working",
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
  kind?: unknown;
  blockedReason?: unknown;
  keptOwedAt?: unknown;
}

/** The session facts the rule reads, measured by the pod in one batched read. */
export interface NeedsYouSessionFacts {
  status: string;
  /** An IS turn is running in the session's room right now. */
  turnInFlight: boolean;
  /**
   * The newest AGENT evidence: an agent room post, a chat turn, an
   * agent-filed proposal, an agent-attributed event. `null` = none yet.
   * Never `updatedAt`. Stopped's clock.
   */
  lastAgentActivityAt: Date | string | null;
  /**
   * The newest agent evidence of WORK: the same sources minus the asking
   * itself (a question post, a `slot_asked` event —
   * {@link NEEDS_YOU_ASKING_EVENT_TYPES}). Working's clock: an agent that
   * asked and stopped is not working. Absent = not measured; then the
   * activity clock stands in (an older reader).
   */
  lastAgentWorkAt?: Date | string | null;
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
 * Was it raised by a real asker? Every cause but a decision ask no agent
 * filed ({@link NEEDS_YOU_AGENT_FILED_CAUSES}). A slot with no stamp at all
 * reads as asked: it predates the stamps (W6a), and every door that wrote one
 * then was an agent's.
 */
export function needsYouHasRealAsker(slot: NeedsYouSlotFacts): boolean {
  const cause = needsYouAskCauseKind(slot);
  if (cause === null) return true;
  if (!(NEEDS_YOU_AGENT_FILED_CAUSES as readonly string[]).includes(cause)) {
    return true;
  }
  return nonEmptyString(slot.askedBy);
}

/**
 * Is it the agent's own question, the kind that ends with its session
 * (`askEndsWithSession`: a confirm / choose, never a criterion grade or a
 * kept-owed ask)? Only those can be Stopped: a person deliverable is still
 * the person's to do when the agent left.
 */
function endsWithSession(slot: NeedsYouSlotFacts): boolean {
  return askEndsWithSession(slot as AskCardSlot);
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
 * Stopped (ended — the terminal set — or no agent evidence for 7 days, the
 * start counting as evidence), working (a turn in flight, or agent evidence
 * of work inside the working window), else live. A session with NO readable
 * clock at all (no agent evidence and no start — a legacy row) is never
 * called stopped: an unreadable clock fails toward keeping, as `askFate` does.
 */
export function needsYouSessionClass(
  session: NeedsYouSessionFacts,
  now: Date | number = Date.now()
): NeedsYouSessionClass {
  const at = now instanceof Date ? now.getTime() : now;
  if (sessionEnded(session.status)) return "stopped";
  const agent = timeOf(session.lastAgentActivityAt);
  const started = timeOf(session.startedAt);
  const moved =
    agent === null
      ? started
      : started === null
        ? agent
        : Math.max(agent, started);
  if (moved !== null && moved < at - NEEDS_YOU_STOPPED_AFTER_MS) {
    return "stopped";
  }
  return needsYouAgentWorking(session, at) ? "working" : "live";
}

/**
 * Working's clock alone: a turn in flight, or agent evidence of WORK inside
 * the working window (`lastAgentWorkAt`; absent = not measured, then the
 * activity clock stands in). THE answer to "is an agent at work on it" for
 * every reader that draws one: the rule above and the card's
 * `sessionUnitInput` (`agentAtWork`), so the two can never fork.
 */
export function needsYouAgentWorking(
  session: Pick<NeedsYouSessionFacts, "turnInFlight" | "lastAgentWorkAt"> & {
    lastAgentActivityAt?: NeedsYouSessionFacts["lastAgentActivityAt"];
  },
  now: Date | number = Date.now()
): boolean {
  if (session.turnInFlight) return true;
  const at = now instanceof Date ? now.getTime() : now;
  const work = timeOf(
    session.lastAgentWorkAt === undefined
      ? session.lastAgentActivityAt
      : session.lastAgentWorkAt
  );
  return work !== null && work >= at - NEEDS_YOU_WORKING_WINDOW_MS;
}

/**
 * THE rule for one slot on its session. `null` when the slot is not owed by
 * the person at all (done, retired, optional, the agent's): it is in no list.
 * On a stopped session only the agent's own question is Stopped; a person
 * deliverable goes on to the age clause.
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
  if (live === "stopped") {
    if (endsWithSession(slot)) return "stopped";
  } else if (live === "working") {
    return "working";
  }
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

// ─── A runner waiting for a permission (decision D-R1) ──────────────────────

/** The facts the rule reads for a session's runners (0384, `foldRunnerState`). */
export interface NeedsYouRunnerFacts {
  /** The session's status. */
  status: string;
  /**
   * The session's LIVE runners, folded (`needs_permission` over `busy` over
   * `idle`); `null` = no live runner named a state.
   */
  runnerState: string | null;
}

/**
 * THE rule for a session whose agent waits on a permission dialog (decision
 * D-R1, founder 2026-11-01): ONE needs-you item per session ("Waiting for
 * your permission"), whatever its other asks and however many of its runners
 * wait — counted through the same rows as every other item, never a second
 * counter. Only the person can answer the dialog, and the agent stands still
 * until they do, so it is never Working, never ages and has a real asker.
 * `null` when no live runner waits on one, or the work ended.
 */
export function classifyRunnerWait(
  facts: NeedsYouRunnerFacts
): "needs_you" | null {
  if (sessionEnded(facts.status)) return null;
  return facts.runnerState === "needs_permission" ? "needs_you" : null;
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
  /**
   * That session's {@link needsYouSessionClass}, when the reader measured it.
   * `null` / absent = not measured, which never demotes (as above).
   */
  sessionClass?: NeedsYouSessionClass | null;
  /**
   * "Later": the time until which THIS reader set the request aside
   * (`proposal_snoozes`, founder decision G3). Per person — another reader's
   * facts never carry it. Absent / `null` / past = not set aside.
   */
  snoozedUntil?: Date | string | null;
}

/**
 * THE rule for one pending proposal. A request the reader set aside ("Later")
 * is Review later for them until that time, whatever else holds: they chose
 * it. Otherwise it needs you only when something WAITS on
 * it (a gate, an owed slot, a parked run) on work that has not ended. A gate
 * is a commitment: it never waits behind a working agent and never ages. Any
 * other wait waits with its session while an agent works it (F2, E2's
 * "asks you when you can"), and goes to Review later after 7 days. Every
 * other pending proposal is a change to review. `null` when it is not
 * pending.
 */
export function classifyPendingProposal(
  p: NeedsYouProposalFacts,
  now: Date | number = Date.now()
): NeedsYouProposalClass | null {
  if (p.status !== "pending") return null;
  const at = now instanceof Date ? now.getTime() : now;
  const snoozedUntil = timeOf(p.snoozedUntil);
  if (snoozedUntil !== null && snoozedUntil > at) return "review_later";
  if (!p.waits.waits) return "changes_to_review";
  if (p.sessionId !== null && sessionEnded(p.sessionStatus)) {
    return "changes_to_review";
  }
  if (p.waits.reason !== "gate") {
    if (p.sessionClass === "working") return "working";
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
