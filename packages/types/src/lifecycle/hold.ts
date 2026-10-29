/**
 * HOLDS AND OCCURRED TIME (status-flow plan W4) — what a pause waits on, and
 * when a move really happened.
 *
 * A move INTO a paused-category status carries a hold: what the thing waits on
 * (`on` + `ref`), why, and how it resumes (`until`: a date, or another thing's
 * move). There is no hold store: the hold travels in the transition that
 * entered the pause, and the CURRENT hold is read off the transition log
 * (`listHolds`, @synap/database). A move between two paused statuses (the
 * reaper's `paused → stale`) keeps the hold it had unless the mover gives a
 * new one.
 *
 * Who must say it: an AGENT's pause without a hold is refused
 * ({@link HOLD_REQUIRED_MESSAGE}); a person's or the system's is recorded
 * `unspecified` (a person's move always wins, `apply-status-move.ts`). An
 * open-ended hold (no date to resume on) always gets a `reviewBy`, so no pause
 * is open forever: 14 days, 7 for runs and pipelines (plan Q2.2). A passed
 * `reviewBy` is NOT a move; it is a signal for the watcher.
 *
 * Pure: no imports at run time (relay and the browser read this module).
 */
import type { TransitionSubjectType } from "./index.js";

/** What a paused thing waits on. */
export const HOLD_ON = [
  "person",
  "agent",
  "external",
  "thing",
  "decision",
  "date",
  "nobody",
  "unspecified",
] as const;
export type HoldOn = (typeof HOLD_ON)[number];

/**
 * How a hold resumes: on a calendar date (ISO), or when the awaited thing moves
 * (`moves` = `<subjectType>:<id>`, e.g. `entity:…`, `track:…`,
 * `focus_session:…`), optionally only when it reaches `to` (a status key, or a
 * category such as `done`).
 */
export type HoldUntil = { date: string } | { moves: string; to?: string };

/** A hold as a mover gives it. */
export interface Hold {
  on: HoldOn;
  /** Who or what: `person:<id>`, `company:<id>`, `check:<stage>`, a free label. */
  ref?: string | null;
  reason?: string | null;
  until?: HoldUntil | null;
  /** ISO date by which someone looks at it again (never a move). */
  reviewBy?: string | null;
}

/**
 * A hold as the transition records it: the mover's hold plus what the server
 * knows. `resumeTo` is the status the thing left when the pause BEGAN (a
 * carried hold keeps it), so a resume by date or by move goes back there;
 * `since` is when the pause began (its occurred time).
 */
export interface RecordedHold extends Hold {
  resumeTo: string | null;
  since: string;
}

/**
 * The refusal an agent's pause without a hold gets — names the field and its
 * shape, so the agent can fix the call in one try.
 */
export const HOLD_REQUIRED_MESSAGE =
  'A pause must say what it waits on: pass `hold` with the move, e.g. { "on": "person" | "agent" | "external" | "thing" | "decision" | "date", "ref": "<who or what>", "reason": "<why>", "until": { "date": "<ISO date>" } or { "moves": "<entity|track|focus_session>:<id>", "to": "<status>" } }. An agent cannot pause without one.';

/** `hold` given with a move that is not a pause. */
export const HOLD_NOT_A_PAUSE_MESSAGE =
  "`hold` is only for a move into a paused status; this move does not pause.";

/** Default review window for an open-ended hold (plan Q2.2). */
export const HOLD_REVIEW_DAYS = { default: 14, run: 7, pipeline: 7 } as const;
export type HoldReviewBase = keyof typeof HOLD_REVIEW_DAYS;

/** How far back a move may say it happened (plan Q3.2). */
export const OCCURRED_AT_MAX_PAST_DAYS = 30;

const DAY_MS = 86_400_000;

const MOVES_SUBJECTS: readonly TransitionSubjectType[] = [
  "entity",
  "track",
  "focus_session",
];

/** `entity:<id>` → its parts, or null when it names no transition subject. */
export function parseHoldMovesRef(
  ref: string
): { subjectType: TransitionSubjectType; subjectId: string } | null {
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const subjectType = ref.slice(0, i) as TransitionSubjectType;
  const subjectId = ref.slice(i + 1);
  return MOVES_SUBJECTS.includes(subjectType) && subjectId
    ? { subjectType, subjectId }
    : null;
}

function isoTime(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? NaN : t;
}

/**
 * What is wrong with a hold a mover gave, or null. `until.date` and
 * `reviewBy` must lie ahead (a passed date would resume or nag at once);
 * `until.moves` must name a transition subject.
 */
export function holdProblem(hold: Hold, now: Date): string | null {
  if (!(HOLD_ON as readonly string[]).includes(hold.on)) {
    return `hold.on must be one of ${HOLD_ON.join(" | ")}.`;
  }
  const until = hold.until;
  if (until && "date" in until) {
    const t = isoTime(until.date);
    if (t === null || Number.isNaN(t)) {
      return "hold.until.date must be an ISO date.";
    }
    if (t <= now.getTime()) return "hold.until.date must be in the future.";
  } else if (until && "moves" in until) {
    if (!parseHoldMovesRef(until.moves)) {
      return `hold.until.moves must be "<${MOVES_SUBJECTS.join("|")}>:<id>".`;
    }
  }
  const review = isoTime(hold.reviewBy);
  if (review !== null && (Number.isNaN(review) || review <= now.getTime())) {
    return "hold.reviewBy must be an ISO date in the future.";
  }
  return null;
}

/**
 * The hold as it is recorded: `reviewBy` defaulted when nothing would resume
 * it on a date (plan: no pause is open-ended), plus the server's fields.
 */
export function recordHold(
  hold: Hold,
  at: { resumeTo: string | null; since: Date; base?: HoldReviewBase | null }
): RecordedHold {
  const datedResume = hold.until != null && "date" in hold.until;
  const reviewBy =
    hold.reviewBy ??
    (datedResume
      ? null
      : new Date(
          at.since.getTime() + HOLD_REVIEW_DAYS[at.base ?? "default"] * DAY_MS
        ).toISOString());
  return {
    on: hold.on,
    ref: hold.ref ?? null,
    reason: hold.reason ?? null,
    // A date is stored as ISO, so the sweep's SQL cast reads every one.
    until:
      hold.until && "date" in hold.until
        ? { date: new Date(hold.until.date).toISOString() }
        : (hold.until ?? null),
    reviewBy,
    resumeTo: at.resumeTo,
    since: at.since.toISOString(),
  };
}

/** The hold a person's or the system's pause gets when it gives none. */
export const UNSPECIFIED_HOLD: Hold = { on: "unspecified" };

/**
 * When a move happened. `occurredAt` defaults to now; it may lie up to
 * {@link OCCURRED_AT_MAX_PAST_DAYS} days back, never ahead. A move that says
 * it happened earlier than it is recorded is `backdated` (a correction is a
 * new record, never an edit of an old one).
 */
export function resolveOccurredAt(
  occurredAt: string | Date | null | undefined,
  now: Date = new Date()
):
  | { ok: true; occurredAt: Date; recordedAt: Date; backdated: boolean }
  | { ok: false; message: string } {
  if (occurredAt == null || occurredAt === "") {
    return { ok: true, occurredAt: now, recordedAt: now, backdated: false };
  }
  const at = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, message: "occurredAt must be an ISO date-time." };
  }
  if (at.getTime() > now.getTime()) {
    return { ok: false, message: "occurredAt cannot be in the future." };
  }
  if (now.getTime() - at.getTime() > OCCURRED_AT_MAX_PAST_DAYS * DAY_MS) {
    return {
      ok: false,
      message: `occurredAt may be at most ${OCCURRED_AT_MAX_PAST_DAYS} days in the past.`,
    };
  }
  return {
    ok: true,
    occurredAt: at,
    recordedAt: now,
    backdated: at.getTime() < now.getTime(),
  };
}

/**
 * Whether the awaited thing's move wakes a hold: any move of it, or only one
 * that lands on `until.to` (a status key, or a category).
 */
export function holdWokenBy(
  until: HoldUntil | null | undefined,
  moved: {
    subjectType: string;
    subjectId: string;
    to: string;
    category: string;
  }
): boolean {
  if (!until || !("moves" in until)) return false;
  if (until.moves !== `${moved.subjectType}:${moved.subjectId}`) return false;
  return (
    until.to == null || until.to === moved.to || until.to === moved.category
  );
}

export type MoveHoldDecision =
  | { ok: true; hold: RecordedHold | null }
  | {
      ok: false;
      code: "HOLD_REQUIRED" | "HOLD_INVALID" | "HOLD_NOT_A_PAUSE";
      message: string;
    };

/**
 * THE HOLD RULE, one place for every door (an entity's `moveStatus`, a goal's
 * status door, `setSessionStatus`):
 *  - not a pause: no hold (one given is refused, never dropped);
 *  - between two paused statuses with no new hold: the hold it had carries on
 *    (`current`, read off the log), so the reaper's `paused → stale` does not
 *    erase a person's "until 10 Nov";
 *  - into a pause: the mover's hold, checked; none from an AGENT is refused;
 *    none from a person or the system is `fallback` (default `unspecified`).
 * `resumeTo` is the status the pause began from, kept across carried moves.
 */
export function decideMoveHold(input: {
  from: string | null;
  fromCategory: string | null;
  toCategory: string;
  actorKind: "human" | "agent" | "system";
  /**
   * A person approved this move (a proposal replay): an agent's pause filed
   * without a hold (before holds existed) is then recorded `unspecified`,
   * never refused after the person said yes.
   */
  approved?: boolean;
  given?: Hold | null;
  /** The hold in force when the thing is already paused. */
  current?: RecordedHold | null;
  /** What a person's or the system's pause records when it gives none. */
  fallback?: Hold;
  since: Date;
  base?: HoldReviewBase | null;
}): MoveHoldDecision {
  const given = input.given ?? null;
  if (input.toCategory !== "paused") {
    return given
      ? {
          ok: false,
          code: "HOLD_NOT_A_PAUSE",
          message: HOLD_NOT_A_PAUSE_MESSAGE,
        }
      : { ok: true, hold: null };
  }
  const alreadyPaused = input.fromCategory === "paused";
  if (alreadyPaused && !given && input.current) {
    return { ok: true, hold: input.current };
  }
  const resumeTo = alreadyPaused
    ? (input.current?.resumeTo ?? null)
    : input.from;
  if (given) {
    const problem = holdProblem(given, input.since);
    if (problem) return { ok: false, code: "HOLD_INVALID", message: problem };
    return {
      ok: true,
      hold: recordHold(given, {
        resumeTo,
        since: input.since,
        base: input.base,
      }),
    };
  }
  if (input.actorKind === "agent" && !input.approved) {
    return { ok: false, code: "HOLD_REQUIRED", message: HOLD_REQUIRED_MESSAGE };
  }
  return {
    ok: true,
    hold: recordHold(input.fallback ?? UNSPECIFIED_HOLD, {
      resumeTo,
      since: input.since,
      base: input.base,
    }),
  };
}
