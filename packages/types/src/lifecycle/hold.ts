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
 * category such as `done`). `moves` may also name a DEV FACT
 * ({@link HoldDevRef}: `pr:<owner/name>#<n>`, `main:<owner/name>`,
 * `job:<name>`): the hold then resumes when a producer posts that fact.
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
  'A pause must say what it waits on: pass `hold` with the move, e.g. { "on": "person" | "agent" | "external" | "thing" | "decision" | "date" | "nobody", "ref": "<who or what>", "reason": "<why>", "until": { "date": "<ISO date>" } or { "moves": "<entity|track|focus_session>:<id>", "to": "<status>" } or { "moves": "pr:<owner/name>#<n>" | "main:<owner/name>" | "job:<devbox job name>" } }. An agent cannot pause without one. Retry the same move with `hold` added.';

/**
 * The dev-fact forms of `until.moves`, in one line: what an agent reads in a
 * tool's text and in a refusal (HOLD_REQUIRED_MESSAGE spells the same forms).
 *
 * The fact is read under the hold OWNER's own events only (the hold-resume
 * worker), never the workspace-shared event floor: a hold ACTS on a fact, so
 * another member's recorded `dev.pr_merged` must not resume it.
 */
export const HOLD_DEV_MOVES_HELP =
  "'pr:<owner/name>#<n>' resumes when that pull request merges (to: 'closed' = when it is closed without merging); 'main:<owner/name>' when that repo's main is green again; 'job:<devbox job name>' when that devbox job finishes (to: 'passed' | 'failed' = only that verdict)";

/** An agent's `on: "unspecified"`: the default a person gets, never an agent's answer. */
export const HOLD_UNSPECIFIED_BY_AGENT_MESSAGE =
  '`hold.on: "unspecified"` is not an answer an agent can give: say what the pause waits on (person, agent, external, thing, decision, date or nobody).';

/** `hold` given with a move that is not a pause. */
export const HOLD_NOT_A_PAUSE_MESSAGE =
  "`hold` only applies when the move pauses something. Remove it, or move to a paused status.";

/** `occurredAt` given with a call that moves no status. */
export const OCCURRED_AT_NOT_A_MOVE_MESSAGE =
  "`occurredAt` only applies to a status move. Remove it, or change the status.";

/** Said back when a move carried a hold or a time but the status did not change. */
export const MOVE_FACTS_IGNORED_NOTICE =
  "The status did not change, so the hold and occurredAt were ignored. Send them with a real status change.";

/** The refusal for a hold or a time sent with no move to carry it. */
export function moveFactsWithoutMoveMessage(given: {
  hold?: unknown;
  occurredAt?: unknown;
}): string {
  return given.hold ? HOLD_NOT_A_PAUSE_MESSAGE : OCCURRED_AT_NOT_A_MOVE_MESSAGE;
}

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

/**
 * A DEV FACT a hold can wait on (plan P1.4) — not a transition subject but a
 * fact a producer posts (`events/dev-loop.ts`):
 *  - `pr:<owner/name>#<n>`: the PR merged (`dev.pr_merged`), or with
 *    `to: "closed"` closed without merging (`dev.pr_closed`);
 *  - `main:<owner/name>`: the repo's main is green again — a
 *    `dev.repo_snapshot` observed after the pause began says `health: ok`;
 *  - `job:<name>`: the devbox job ended — its `ci.finished` (workflow
 *    `devbox <name>`) after the pause began; with `to: "passed" | "failed"`
 *    only that verdict.
 * Whether the fact is in is decided by `holdDevRefMet` (`events/dev-hold.ts`).
 */
export type HoldDevRef =
  | { kind: "pr"; repo: string; number: number }
  | { kind: "main"; repo: string }
  | { kind: "job"; name: string };

/** The `until.to` each dev fact accepts; absent = the first (pr) or any (job). */
export const HOLD_DEV_TO = {
  pr: ["merged", "closed"],
  main: [],
  job: ["passed", "failed"],
} as const satisfies Record<HoldDevRef["kind"], readonly string[]>;

const DEV_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEV_JOB_RE = /^[A-Za-z0-9_.-]{1,200}$/;

/** `pr:<owner/name>#<n>` / `main:<owner/name>` / `job:<name>` → its parts, else null. */
export function parseHoldDevRef(ref: string): HoldDevRef | null {
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const kind = ref.slice(0, i);
  const rest = ref.slice(i + 1).trim();
  if (kind === "pr") {
    const hash = rest.lastIndexOf("#");
    const repo = rest.slice(0, hash);
    const number = Number(rest.slice(hash + 1));
    return hash > 0 &&
      DEV_REPO_RE.test(repo) &&
      Number.isSafeInteger(number) &&
      number > 0
      ? { kind, repo, number }
      : null;
  }
  if (kind === "main")
    return DEV_REPO_RE.test(rest) ? { kind, repo: rest } : null;
  if (kind === "job")
    return DEV_JOB_RE.test(rest) ? { kind, name: rest } : null;
  return null;
}

/**
 * The ONE spelling of a dev ref, as `until.moves` stores it (repo lowercased:
 * GitHub compares it case-insensitively), so the resume finds the hold by an
 * exact match on the indexed `until.moves` (0374).
 */
export function holdDevMovesRef(ref: HoldDevRef): string {
  switch (ref.kind) {
    case "pr":
      return `pr:${ref.repo.toLowerCase()}#${ref.number}`;
    case "main":
      return `main:${ref.repo.toLowerCase()}`;
    case "job":
      return `job:${ref.name}`;
  }
}

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
 * `until.moves` must name a transition subject or a dev fact (with a `to`
 * that fact accepts).
 */
export function holdProblem(
  hold: Hold,
  now: Date,
  /**
   * Shape only (an approved replay): a date that passed while the proposal
   * waited is not a fault — the hourly sweep resumes a passed `until.date`.
   */
  opts: { shapeOnly?: boolean } = {}
): string | null {
  if (!(HOLD_ON as readonly string[]).includes(hold.on)) {
    return `hold.on must be one of ${HOLD_ON.join(" | ")}.`;
  }
  const until = hold.until;
  if (until && "date" in until) {
    const t = isoTime(until.date);
    if (t === null || Number.isNaN(t)) {
      return "hold.until.date must be an ISO date.";
    }
    if (!opts.shapeOnly && t <= now.getTime()) {
      return "hold.until.date must be in the future.";
    }
  } else if (until && "moves" in until) {
    const dev = parseHoldDevRef(until.moves);
    if (dev) {
      const accepted: readonly string[] = HOLD_DEV_TO[dev.kind];
      if (until.to != null && !accepted.includes(until.to)) {
        return accepted.length
          ? `hold.until.to for "${dev.kind}:" must be ${accepted.join(" or ")}.`
          : `hold.until.to does not apply to "${dev.kind}:": remove it.`;
      }
    } else if (!parseHoldMovesRef(until.moves)) {
      return `hold.until.moves must be "<${MOVES_SUBJECTS.join("|")}>:<id>", or a dev fact: ${HOLD_DEV_MOVES_HELP}.`;
    }
  }
  const review = isoTime(hold.reviewBy);
  if (
    review !== null &&
    (Number.isNaN(review) || (!opts.shapeOnly && review <= now.getTime()))
  ) {
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
  // Stored in ONE stamp shape (`toISOString`), so the watcher compares it as
  // text and never casts a value written another way.
  const given = hold.reviewBy ? Date.parse(hold.reviewBy) : NaN;
  const reviewBy = Number.isFinite(given)
    ? new Date(given).toISOString()
    : datedResume
      ? null
      : new Date(
          at.since.getTime() + HOLD_REVIEW_DAYS[at.base ?? "default"] * DAY_MS
        ).toISOString();
  return {
    on: hold.on,
    ref: hold.ref ?? null,
    reason: hold.reason ?? null,
    // A date is stored as ISO, so the sweep's SQL cast reads every one; a
    // dev ref in its one spelling, so its fact finds it by exact match.
    until:
      hold.until && "date" in hold.until
        ? { date: new Date(hold.until.date).toISOString() }
        : (canonicalMoves(hold.until) ?? null),
    reviewBy,
    resumeTo: at.resumeTo,
    since: at.since.toISOString(),
  };
}

function canonicalMoves(
  until: Exclude<HoldUntil, { date: string }> | null | undefined
): HoldUntil | null | undefined {
  const dev = until ? parseHoldDevRef(until.moves) : null;
  return until && dev ? { ...until, moves: holdDevMovesRef(dev) } : until;
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
  /** When the pause began (the move's `occurredAt`). */
  since: Date;
  /** When the move is recorded: what a hold's dates must lie ahead of. */
  now?: Date;
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
    if (
      given.on === "unspecified" &&
      input.actorKind === "agent" &&
      !input.approved
    ) {
      return {
        ok: false,
        code: "HOLD_INVALID",
        message: HOLD_UNSPECIFIED_BY_AGENT_MESSAGE,
      };
    }
    const problem = holdProblem(given, input.now ?? new Date(), {
      shapeOnly: input.approved,
    });
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
  // Already paused with no hold on record (paused or reaped before holds
  // existed): it is not a NEW pause, so nothing is asked of the mover — the
  // fallback is recorded, as the pre-governance checks assume.
  if (input.actorKind === "agent" && !input.approved && !alreadyPaused) {
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
