/**
 * WHAT A GOAL HOLDS — the pure half (work model W2, 2026-10-23).
 *
 * A goal (a track, `project_tracks`) holds an end state, 0 or 2–5 criteria,
 * drop conditions, a kind of work and an uncertainty level; per criterion, an
 * acceptance. Everything here that is not stored is DERIVED, never a second
 * store: a goal criterion's mark comes from the session criteria of the same
 * key in the sessions filed into the goal (their `session_evaluations` rows,
 * read by the same `latestEvaluationPerCriterion` a session's verdict uses);
 * "in review" and "waiting on" are marks, never statuses.
 *
 * PURE and dependency-free: the pod, Relay, the browser and the CLI import the
 * same answer. Words: `@synap-core/types/vocabulary` (`resolveGoal*Label`).
 */

import {
  latestEvaluationPerCriterion,
  type EvaluationRowLike,
  type EvaluatorKind,
} from "../focus-sessions/verdict.js";
import type {
  CRITERION_CHECK_MEANING_LABELS,
  GOAL_ACCEPTANCE_LABELS,
  GOAL_CRITERION_MARK_LABELS,
  TRACK_UNCERTAINTY_LABELS,
  TRACK_WORK_KIND_LABELS,
  WAITING_ON_REASON_LABELS,
} from "../vocabulary/index.js";
import { deliverableOwedBy, type DeliverableFacts } from "./deliverable.js";

// ── kind of work and uncertainty (decision 4) ──────────────────────────────

/**
 * The KIND of work a goal is (decision 4). Proposed by the AI, confirmed by a
 * person (`kindConfirmedBy/At` on the track). Stored as `project_tracks.work_kind`
 * (the CHECK constraint spells the same set — migration 0345).
 */
export const TRACK_WORK_KINDS = [
  "project",
  "flow",
  "operation",
  "investigation",
  "incident",
  "commission",
  "pathway",
] as const;
export type TrackWorkKind = (typeof TRACK_WORK_KINDS)[number];

/** How well the way to the end is known (decision 4) — `project_tracks.uncertainty`. */
export const TRACK_UNCERTAINTY_LEVELS = [
  "clear",
  "complicated",
  "complex",
  "chaotic",
  "unknown",
] as const;
export type TrackUncertainty = (typeof TRACK_UNCERTAINTY_LEVELS)[number];

export function isTrackWorkKind(v: unknown): v is TrackWorkKind {
  return (
    typeof v === "string" && (TRACK_WORK_KINDS as readonly string[]).includes(v)
  );
}

export function isTrackUncertainty(v: unknown): v is TrackUncertainty {
  return (
    typeof v === "string" &&
    (TRACK_UNCERTAINTY_LEVELS as readonly string[]).includes(v)
  );
}

// ── criteria on a goal (decision 1) ────────────────────────────────────────

/**
 * A goal with NO criteria is a lasting goal. A goal WITH criteria has 2 to 5
 * (decision 1): one is a task, six is a plan. The goal write door refuses
 * any other count.
 */
export const GOAL_CRITERIA_MIN = 2;
export const GOAL_CRITERIA_MAX = 5;

/** `null` = allowed; otherwise the refusal in words an agent can act on. */
export function checkGoalCriteriaCount(count: number): string | null {
  if (count === 0) return null;
  if (count >= GOAL_CRITERIA_MIN && count <= GOAL_CRITERIA_MAX) return null;
  return `A goal has no criteria (it stays open as long as it matters) or ${GOAL_CRITERIA_MIN} to ${GOAL_CRITERIA_MAX} of them — not ${count}.`;
}

// ── R5: what kind of check a criterion is ──────────────────────────────────

/**
 * R5 — WHAT KIND of check a criterion is, in people's words. A MEANING
 * layer, never a stored evaluator: each word maps onto the four stored
 * evaluator kinds ({@link CHECK_MEANING_EVALUATORS}).
 *
 *   measured         — a number or a fact a machine checks (evidence, capability)
 *   judged           — a person's call (an AI judge may advise; it never accepts)
 *   handed_over      — a deliverable handed over (its evidence, or a person's grade)
 *   learning         — about the METHOD, not the answer (R7: `about: "method"`)
 *   decided_outside  — an outside party decides; recorded as a person's grade
 *                      with the source attached (rationale / evidence)
 *   certified        — a third party certifies; the same, with the certificate
 *
 * Mirrored by `CRITERION_CHECK_MEANINGS` in `@synap/playbooks` (the criterion
 * reader), pinned equal by `api/__tripwires__/criterion-meaning-parity.test.ts`.
 */
export const CRITERION_CHECK_MEANINGS = [
  "measured",
  "judged",
  "handed_over",
  "learning",
  "decided_outside",
  "certified",
] as const;
export type CriterionCheckMeaning = (typeof CRITERION_CHECK_MEANINGS)[number];

/** R7 — what a criterion is about: the result (default) or the method. */
export const CRITERION_ABOUT = ["result", "method"] as const;
export type CriterionAbout = (typeof CRITERION_ABOUT)[number];

/**
 * THE mapping, defined once: the stored evaluator kinds (`check.kind`) a
 * criterion of each meaning may be checked by. `learning` is about WHAT is
 * checked (the method), so any evaluator fits.
 */
export const CHECK_MEANING_EVALUATORS = {
  measured: ["evidence", "capability"],
  judged: ["human", "judge"],
  handed_over: ["evidence", "human"],
  learning: ["evidence", "capability", "judge", "human"],
  decided_outside: ["human"],
  certified: ["human"],
} as const satisfies Record<CriterionCheckMeaning, readonly EvaluatorKind[]>;

/** The fields of a criterion the goal rules read — structural, any copy fits. */
export interface GoalCriterionLike {
  key: string;
  statement?: string;
  /** Absent = true. */
  required?: boolean;
  check: { kind: EvaluatorKind };
  checkKind?: string | null;
  about?: string | null;
}

/**
 * The meaning of a criterion: its declared `checkKind`; else `learning` when
 * it is about the method; else the evaluator's own (evidence / capability →
 * measured, a person or an AI judge → judged).
 */
export function criterionMeaning(c: GoalCriterionLike): CriterionCheckMeaning {
  if (
    c.checkKind &&
    (CRITERION_CHECK_MEANINGS as readonly string[]).includes(c.checkKind)
  ) {
    return c.checkKind as CriterionCheckMeaning;
  }
  if (c.about === "method") return "learning";
  return c.check.kind === "evidence" || c.check.kind === "capability"
    ? "measured"
    : "judged";
}

/**
 * Refuse a criterion whose declared meaning its check cannot carry — a
 * `measured` criterion graded by a person is not measured. `null` = coherent.
 */
export function checkCriterionMeaning(c: GoalCriterionLike): string | null {
  if (!c.checkKind) return null;
  if (!(CRITERION_CHECK_MEANINGS as readonly string[]).includes(c.checkKind)) {
    return `Criterion "${c.key}": checkKind must be one of ${CRITERION_CHECK_MEANINGS.join(", ")}.`;
  }
  const meaning = c.checkKind as CriterionCheckMeaning;
  const allowed: readonly EvaluatorKind[] = CHECK_MEANING_EVALUATORS[meaning];
  if (!allowed.includes(c.check.kind)) {
    return `Criterion "${c.key}": a ${meaning} criterion is checked by ${allowed.join(" or ")}, not ${c.check.kind}.`;
  }
  if (meaning === "learning" && c.about === "result") {
    return `Criterion "${c.key}": a learning criterion is about the method — set about to "method" or omit it.`;
  }
  return null;
}

// ── R2: acceptance ─────────────────────────────────────────────────────────

/**
 * What the goal's judge decided about a claimed criterion (R2) — stored on the
 * goal criterion entry (`acceptance`), written ONLY by the acceptance door.
 * "Waiting" is not stored: it is a claim with no decision yet.
 */
export const GOAL_ACCEPTANCE_DECISIONS = [
  "accepted",
  "changes_asked",
  "rejected",
] as const;
export type GoalAcceptanceDecision = (typeof GOAL_ACCEPTANCE_DECISIONS)[number];

/** Acceptance as a reader sees it — the decisions plus the derived `waiting`. */
export const GOAL_ACCEPTANCE_STATES = [
  "waiting",
  ...GOAL_ACCEPTANCE_DECISIONS,
] as const;
export type GoalAcceptanceState = (typeof GOAL_ACCEPTANCE_STATES)[number];

/** The stored record of a judge's decision on one goal criterion. */
export interface GoalCriterionAcceptance {
  decision: GoalAcceptanceDecision;
  /** The person who decided. */
  by: string;
  /** ISO-8601. */
  at: string;
  /** Why, in words — what to change, or why it was rejected. */
  note?: string;
}

/** Read a stored acceptance — tolerant: anything malformed reads as none. */
export function readGoalCriterionAcceptance(
  raw: unknown
): GoalCriterionAcceptance | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    !(GOAL_ACCEPTANCE_DECISIONS as readonly unknown[]).includes(r.decision) ||
    typeof r.by !== "string" ||
    !r.by ||
    typeof r.at !== "string" ||
    Number.isNaN(new Date(r.at).getTime())
  ) {
    return null;
  }
  return {
    decision: r.decision as GoalAcceptanceDecision,
    by: r.by,
    at: r.at,
    ...(typeof r.note === "string" && r.note.trim()
      ? { note: r.note.trim() }
      : {}),
  };
}

/** Who is trying to accept a criterion. */
export type GoalAcceptor =
  | {
      kind: "person";
      /** The goal's judge (until participants exist: its owner). */
      isJudge: boolean;
    }
  | { kind: "agent" }
  | {
      kind: "automatic";
      /** The check's evaluator worked the run it checks (R9). */
      isAuthor: boolean;
    };

/**
 * WHO MAY ACCEPT a goal criterion (R2, R9) — one answer for the door and the
 * derivation. An agent never; a person only as the goal's judge; an
 * automatic check only a MEASURED criterion, and never the author's own work.
 * `null` = allowed; otherwise why not.
 */
export function mayAcceptGoalCriterion(
  criterion: GoalCriterionLike,
  by: GoalAcceptor
): string | null {
  if (by.kind === "agent") {
    return "An agent cannot accept a goal's criterion — the goal's judge does.";
  }
  if (by.kind === "person") {
    return by.isJudge
      ? null
      : "Only the goal's judge can accept, send back or reject its criteria.";
  }
  if (criterionMeaning(criterion) !== "measured") {
    return `"${criterion.key}" is not a measured criterion — a person accepts it.`;
  }
  return by.isAuthor
    ? `"${criterion.key}" was checked by the one who did the work — a person accepts it.`
    : null;
}

// ── derived marks per criterion ────────────────────────────────────────────

/**
 * Where one goal criterion stands — DERIVED, never stored:
 *   met         — passed and accepted (by the judge, a person's grade, or a
 *                 measured check that is not the author's own work);
 *   claimed     — passed, waiting on the judge;
 *   under_way   — not passing yet, and an open run is working on it;
 *   not_met     — worked on, not passing, nothing open on it (or sent back);
 *   not_started — no run has ever carried it.
 */
export const GOAL_CRITERION_MARKS = [
  "met",
  "claimed",
  "under_way",
  "not_met",
  "not_started",
] as const;
export type GoalCriterionMark = (typeof GOAL_CRITERION_MARKS)[number];

/** One evaluation row as the goal derivation reads it. */
export interface GoalEvaluationRowLike extends EvaluationRowLike {
  evaluatorId?: string | null;
  rationale?: string | null;
}

/** One run (session) filed into the goal, as the derivation reads it. */
export interface GoalRunFacts {
  sessionId: string;
  /** Not closed, cancelled or failed. */
  open: boolean;
  /** The keys of the criteria this run carries. */
  criterionKeys: readonly string[];
  /**
   * Everyone who WORKED it — the owner, its roster, the model it ran on. An
   * evidence row they posted is the author's own claim (R9).
   */
  authors: readonly string[];
  evaluations: readonly GoalEvaluationRowLike[];
}

/** What the derivation adds to each goal criterion. */
export interface GoalCriterionState {
  key: string;
  mark: GoalCriterionMark;
  /** `null` = nothing claimed and no decision on it. */
  acceptanceState: GoalAcceptanceState | null;
  meaning: CriterionCheckMeaning;
  /**
   * A measured criterion's latest measured value, in the words the check
   * gave (`"9 of 12 pages migrated"`); `null` when none was recorded.
   */
  currentValue: string | null;
}

/**
 * One goal criterion as every track read returns it (`TrackView.criteria`):
 * the stored criterion (the session criterion shape), the judge's stored
 * decision, and the derived state. `mark` is `null` only on a view that could
 * not read the goal's runs (a write's fallback) — never a guessed
 * `not_started`.
 */
export interface GoalCriterionView {
  key: string;
  statement: string;
  required?: boolean;
  check: {
    kind: EvaluatorKind;
    capability?: string;
    evidenceKey?: string;
    hint?: string;
  };
  stageKey?: string;
  checkKind?: CriterionCheckMeaning;
  about?: CriterionAbout;
  /** The judge's stored decision — `null` until one is made. */
  acceptance: GoalCriterionAcceptance | null;
  mark: GoalCriterionMark | null;
  acceptanceState: GoalAcceptanceState | null;
  meaning: CriterionCheckMeaning;
  currentValue: string | null;
}

function ms(at: Date | string): number {
  const t = new Date(at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * THE derivation of a goal's criteria — every reader (the pod's track read,
 * the close rule, Relay, the browser) uses this one. For each criterion: the
 * current row across every run that carries its key (a person's grade wins,
 * as for a session — `latestEvaluationPerCriterion`), then the judge's
 * decision, then whether a run is still open on it.
 */
export function deriveGoalCriteria(
  criteria: ReadonlyArray<
    GoalCriterionLike & { acceptance?: GoalCriterionAcceptance | null }
  >,
  runs: readonly GoalRunFacts[]
): GoalCriterionState[] {
  return criteria.map((c) => {
    const carrying = runs.filter((r) => r.criterionKeys.includes(c.key));
    const rows = carrying.flatMap((r) =>
      r.evaluations
        .filter((e) => e.criterionKey === c.key)
        .map((e) => ({ ...e, run: r }))
    );
    const current = latestEvaluationPerCriterion(rows)[0] ?? null;
    const meaning = criterionMeaning(c);
    const measured = [...rows]
      .filter(
        (e) =>
          e.evaluatorKind === "evidence" || e.evaluatorKind === "capability"
      )
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
    const currentValue =
      meaning === "measured" && measured?.rationale?.trim()
        ? measured.rationale.trim()
        : null;
    const base = { key: c.key, meaning, currentValue };

    const notPassing = (): GoalCriterionMark =>
      carrying.some((r) => r.open)
        ? "under_way"
        : rows.length > 0 || carrying.length > 0
          ? "not_met"
          : "not_started";

    const decision = c.acceptance ?? null;
    const decidedAt = decision ? ms(decision.at) : 0;
    if (decision?.decision === "accepted") {
      // An acceptance stands until the work regresses after it.
      const regressed =
        current !== null &&
        current.verdict !== "pass" &&
        ms(current.createdAt) > decidedAt;
      if (!regressed) {
        return { ...base, mark: "met", acceptanceState: "accepted" };
      }
    } else if (decision) {
      // Sent back or rejected: stands until a NEWER claim reopens review.
      const reclaimed =
        current?.verdict === "pass" && ms(current.createdAt) > decidedAt;
      if (!reclaimed) {
        return {
          ...base,
          mark: notPassing(),
          acceptanceState: decision.decision,
        };
      }
    }

    if (current?.verdict === "pass") {
      if (current.evaluatorKind === "human") {
        return { ...base, mark: "met", acceptanceState: "accepted" };
      }
      const automatic =
        (current.evaluatorKind === "evidence" ||
          current.evaluatorKind === "capability") &&
        mayAcceptGoalCriterion(c, {
          kind: "automatic",
          isAuthor:
            false &&
            current.evaluatorKind === "evidence" &&
            (!current.evaluatorId ||
              current.run.authors.includes(current.evaluatorId)),
        }) === null;
      return automatic
        ? { ...base, mark: "met", acceptanceState: "accepted" }
        : { ...base, mark: "claimed", acceptanceState: "waiting" };
    }
    return { ...base, mark: notPassing(), acceptanceState: null };
  });
}

/**
 * IN REVIEW (decision 2) — every REQUIRED criterion claimed and none accepted
 * yet. A derived mark inside the active category, never a status. A goal with
 * no required criterion is never in review.
 */
export function goalInReview(
  criteria: ReadonlyArray<Pick<GoalCriterionLike, "key" | "required">>,
  states: ReadonlyArray<Pick<GoalCriterionState, "key" | "mark">>
): boolean {
  const required = criteria.filter((c) => c.required !== false);
  if (required.length === 0) return false;
  const markOf = new Map(states.map((s) => [s.key, s.mark]));
  return required.every((c) => markOf.get(c.key) === "claimed");
}

// ── R4: waiting on ─────────────────────────────────────────────────────────

/**
 * What a goal is WAITING ON (R4) — a derived mark with a reason, never a
 * status, distinct from `paused` (chosen). Read from what exists: the owed
 * slots of its open runs, pending proposals, and `blocked_by` edges.
 */
export const WAITING_ON_REASONS = [
  "input",
  "approval",
  "access",
  "another_work",
  "outside_world",
] as const;
export type WaitingOnReason = (typeof WAITING_ON_REASONS)[number];

/**
 * Each blocked reason of an owed slot (`BLOCKED_REASONS`, `@synap/playbooks`)
 * → what the goal waits on. Explicit for EVERY blocked reason:
 * `api/__tripwires__/waiting-on-blocked-reasons.test.ts` fails when a blocked
 * reason has no row here, so a new one cannot fall silently to "input".
 */
export const BLOCKED_REASON_WAITING_ON = {
  credential: "access",
  permission: "access",
  capability: "access",
  policy: "access",
  decision: "input",
} as const satisfies Record<string, WaitingOnReason>;

/** One thing a goal waits on, as the pod found it. */
export type WaitingOnSource =
  | {
      kind: "owed_slot";
      /** The slot's blocked reason; absent = a question, a param, an ask. */
      blockedReason?: string | null;
    }
  | { kind: "pending_proposal" }
  | { kind: "blocked_by" };

/** THE mapping from one source to its reason. */
export function waitingOnReasonOf(source: WaitingOnSource): WaitingOnReason {
  switch (source.kind) {
    case "pending_proposal":
      return "approval";
    case "blocked_by":
      return "another_work";
    case "owed_slot": {
      const r = source.blockedReason?.trim().toLowerCase();
      return r && Object.hasOwn(BLOCKED_REASON_WAITING_ON, r)
        ? BLOCKED_REASON_WAITING_ON[r as keyof typeof BLOCKED_REASON_WAITING_ON]
        : "input";
    }
  }
}

export interface WaitingOnMark {
  reason: WaitingOnReason;
  count: number;
}

/** The goal's waiting-on marks — one per reason present, in reason order. */
export function deriveWaitingOn(
  sources: readonly WaitingOnSource[]
): WaitingOnMark[] {
  const counts = new Map<WaitingOnReason, number>();
  for (const s of sources) {
    const reason = waitingOnReasonOf(s);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return WAITING_ON_REASONS.filter((r) => counts.has(r)).map((reason) => ({
    reason,
    count: counts.get(reason)!,
  }));
}

/**
 * The owed slots of an OPEN run as waiting-on sources: a slot a PERSON owes
 * (`deliverableOwedBy === "you"`, the shared deliverable rule).
 */
export function owedSlotWaitingSources(
  slots: ReadonlyArray<
    Pick<DeliverableFacts, "status" | "retiredAt" | "owner" | "optional"> & {
      blockedReason?: string | null;
    }
  >
): WaitingOnSource[] {
  return slots
    .filter((s) => deliverableOwedBy(s) === "you")
    .map((s) => ({
      kind: "owed_slot",
      blockedReason: s.blockedReason ?? null,
    }));
}

// Every value has its words in the vocabulary, and the vocabulary names
// nothing else: a value added on one side only stops the build.
type _SameKeys<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _workKindWords: _SameKeys<
  TrackWorkKind,
  keyof typeof TRACK_WORK_KIND_LABELS
> = true;
const _uncertaintyWords: _SameKeys<
  TrackUncertainty,
  keyof typeof TRACK_UNCERTAINTY_LABELS
> = true;
const _meaningWords: _SameKeys<
  CriterionCheckMeaning,
  keyof typeof CRITERION_CHECK_MEANING_LABELS
> = true;
const _markWords: _SameKeys<
  GoalCriterionMark,
  keyof typeof GOAL_CRITERION_MARK_LABELS
> = true;
const _acceptanceWords: _SameKeys<
  GoalAcceptanceState,
  keyof typeof GOAL_ACCEPTANCE_LABELS
> = true;
const _waitingWords: _SameKeys<
  WaitingOnReason,
  keyof typeof WAITING_ON_REASON_LABELS
> = true;
void _workKindWords;
void _uncertaintyWords;
void _meaningWords;
void _markWords;
void _acceptanceWords;
void _waitingWords;
