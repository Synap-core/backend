/**
 * THE LOOP — a goal proposes its next run (work model W4, decision 1,
 * 2026-10-23): "The track proposes its next session while criteria are unmet
 * (budgeted; stops and asks when the same criterion fails twice)."
 *
 * The pure half. Everything here is DERIVED from what the pod already stores —
 * the goal's criteria and their marks (`deriveGoalCriteria`), the runs filed
 * into the goal and their `session_evaluations` rows — never a second store:
 *
 *   · {@link goalCriteriaFailedTwice} — which required criterion failed (a
 *     non-human `fail`) in two runs of the goal since a person last graded it;
 *   · {@link decideGoalNextRun} — whether the goal proposes its next run now,
 *     and which criteria the run carries (by the SAME key, so the goal's
 *     derivation counts the run's grades), or why it holds.
 *
 * It PROPOSES, never starts: the pod files the run as a proposal a person
 * approves, whoever switched the loop on.
 *
 * PURE and dependency-free: the pod and every surface import the same answer.
 */

import type { LifecycleCategory } from "../lifecycle/option.js";
import type {
  GoalCriterionLike,
  GoalCriterionMark,
  GoalRunFacts,
} from "./goal.js";

/**
 * Whether a NEW goal with criteria starts with its loop on — applied ONCE, at
 * the goal's birth (`startTrack`), and only when the start names no loop. OFF
 * until the founder confirms the north-star default (W4 brief). A stored goal
 * with no loop reads as OFF whatever this says ({@link readGoalLoop}), so
 * flipping it never switches on an existing goal.
 */
export const GOAL_LOOP_DEFAULT_ON = false;

/** Proposals one goal may file per week unless a person sets another budget. */
export const GOAL_LOOP_DEFAULT_PER_WEEK = 3;
/** The highest weekly budget a person may set — one proposal a day, twice. */
export const GOAL_LOOP_MAX_PER_WEEK = 14;
/** The budget's window in days: the last seven, rolling. */
export const GOAL_LOOP_WINDOW_DAYS = 7;
/**
 * Runs in which the SAME required criterion failed before the loop stops and
 * asks the goal's owner. Mirrors `MAX_NON_HUMAN_ATTEMPTS` (two tries per
 * criterion inside one run, api `evaluations/record.ts`) one level up.
 */
export const GOAL_LOOP_FAILS_TO_STOP = 2;

/** The loop as stored on the goal (`project_tracks.loop`, 0350). */
export interface GoalLoopSettings {
  on: boolean;
  /** Proposals per rolling week, 1 to {@link GOAL_LOOP_MAX_PER_WEEK}. */
  perWeek: number;
  /**
   * When a person last switched it on (ISO-8601) — failures before it no
   * longer count: switching the loop on again is "try again".
   */
  onAt: string | null;
  /** Who set it last: the person (the approver, for an agent's proposal). */
  by: string | null;
}

/**
 * Read a stored loop — tolerant: absent or malformed reads as OFF (never the
 * birth default), an out-of-range budget as the nearest allowed one.
 */
export function readGoalLoop(raw: unknown): GoalLoopSettings {
  const bag =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const perWeek =
    typeof bag.perWeek === "number" && Number.isInteger(bag.perWeek)
      ? Math.min(Math.max(bag.perWeek, 1), GOAL_LOOP_MAX_PER_WEEK)
      : GOAL_LOOP_DEFAULT_PER_WEEK;
  const onAt =
    typeof bag.onAt === "string" && !Number.isNaN(Date.parse(bag.onAt))
      ? bag.onAt
      : null;
  return {
    on: bag.on === true,
    perWeek,
    onAt,
    by: typeof bag.by === "string" && bag.by ? bag.by : null,
  };
}

/** A required criterion the loop stopped on, and the runs it failed in. */
export interface GoalLoopStop {
  key: string;
  /** The failing runs, oldest first — at least {@link GOAL_LOOP_FAILS_TO_STOP}. */
  sessionIds: string[];
}

function ms(at: Date | string): number {
  const t = new Date(at).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The REQUIRED criteria that failed in {@link GOAL_LOOP_FAILS_TO_STOP} or more
 * runs of the goal since a person last graded them. A run FAILED a criterion
 * when its latest non-human row on that key is `fail` (two tries inside one run
 * are one run's failure — the session's own rule). A person's grade on the key,
 * in any run, starts the count again: they have answered; so does a person
 * switching the loop on again (`since`). An optional
 * criterion never stops the loop — it never fires the loop either.
 */
export function goalCriteriaFailedTwice(
  criteria: ReadonlyArray<Pick<GoalCriterionLike, "key" | "required">>,
  runs: ReadonlyArray<
    Pick<GoalRunFacts, "sessionId" | "criterionKeys" | "evaluations">
  >,
  /** When a person last switched the loop on: earlier failures do not count. */
  since: Date | string | null = null
): GoalLoopStop[] {
  const sinceMs = since ? ms(since) : 0;
  const out: GoalLoopStop[] = [];
  for (const c of criteria) {
    if (c.required === false) continue;
    const carrying = runs.filter((r) => r.criterionKeys.includes(c.key));
    const rowsOf = (r: (typeof carrying)[number]) =>
      r.evaluations.filter((e) => e.criterionKey === c.key);
    const answeredAt = Math.max(
      sinceMs,
      ...carrying.flatMap((r) =>
        rowsOf(r)
          .filter((e) => e.evaluatorKind === "human")
          .map((e) => ms(e.createdAt))
      )
    );
    const failed = carrying
      .map((r) => {
        const latest = rowsOf(r)
          .filter(
            (e) => e.evaluatorKind !== "human" && ms(e.createdAt) > answeredAt
          )
          .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0];
        return latest?.verdict === "fail"
          ? { sessionId: r.sessionId, at: ms(latest.createdAt) }
          : null;
      })
      .filter((f): f is { sessionId: string; at: number } => f !== null)
      .sort((a, b) => a.at - b.at);
    if (failed.length >= GOAL_LOOP_FAILS_TO_STOP) {
      out.push({ key: c.key, sessionIds: failed.map((f) => f.sessionId) });
    }
  }
  return out;
}

/**
 * Why the loop does not propose now, in the order it is asked:
 *
 *   loop_off          — no person switched it on;
 *   not_active        — the goal is not in the active category (proposed,
 *                       paused, closed, dropped);
 *   no_criteria       — a lasting goal: nothing to meet;
 *   run_open          — a run filed into the goal is still open;
 *   nothing_unmet     — every required criterion is met or waits on the judge;
 *   stopped           — an unmet required criterion failed in two runs: the
 *                       owner is asked, the loop waits for their answer;
 *   proposal_pending  — its last proposal still waits on a person (one at a
 *                       time);
 *   budget_used       — the week's proposals are spent.
 */
export const GOAL_LOOP_HOLDS = [
  "loop_off",
  "not_active",
  "no_criteria",
  "run_open",
  "nothing_unmet",
  "stopped",
  "proposal_pending",
  "budget_used",
] as const;
export type GoalLoopHold = (typeof GOAL_LOOP_HOLDS)[number];

export type GoalLoopDecision =
  | {
      propose: true;
      /** The keys the next run carries: every criterion not met, declared order. */
      carry: string[];
    }
  | {
      propose: false;
      hold: GoalLoopHold;
      /** With `stopped`: the criteria it stopped on. */
      stoppedOn?: GoalLoopStop[];
    };

/** The marks that mean "nobody is on it and it is not done". */
const UNMET_MARKS: ReadonlySet<GoalCriterionMark> = new Set([
  "not_met",
  "not_started",
]);

/**
 * THE rule of the loop — should the goal propose its next run now. Fires when
 * the loop is on, the goal is active, has criteria, no run filed into it is
 * open, at least one REQUIRED criterion is not met (`not_met` / `not_started`
 * — a `claimed` one waits on the judge, not on more work), none of those
 * failed twice, nothing it proposed still waits, and the week's budget is not
 * spent. A mark that could not be read (`null`) never counts as unmet.
 */
export function decideGoalNextRun(input: {
  loop: Pick<GoalLoopSettings, "on" | "perWeek">;
  category: LifecycleCategory | null;
  criteria: ReadonlyArray<Pick<GoalCriterionLike, "key" | "required">>;
  marks: ReadonlyArray<{ key: string; mark: GoalCriterionMark | null }>;
  openRuns: number;
  pendingProposals: number;
  proposedThisWeek: number;
  stops: readonly GoalLoopStop[];
}): GoalLoopDecision {
  if (!input.loop.on) return { propose: false, hold: "loop_off" };
  if (input.category !== "active")
    return { propose: false, hold: "not_active" };
  if (input.criteria.length === 0)
    return { propose: false, hold: "no_criteria" };
  if (input.openRuns > 0) return { propose: false, hold: "run_open" };

  const markOf = new Map(input.marks.map((m) => [m.key, m.mark]));
  const unmet = (key: string) => {
    const m = markOf.get(key);
    return m != null && UNMET_MARKS.has(m);
  };
  const requiredUnmet = input.criteria.filter(
    (c) => c.required !== false && unmet(c.key)
  );
  if (requiredUnmet.length === 0) {
    return { propose: false, hold: "nothing_unmet" };
  }
  const stillFailing = new Set(requiredUnmet.map((c) => c.key));
  const stoppedOn = input.stops.filter((s) => stillFailing.has(s.key));
  if (stoppedOn.length > 0) {
    return { propose: false, hold: "stopped", stoppedOn };
  }
  if (input.pendingProposals > 0) {
    return { propose: false, hold: "proposal_pending" };
  }
  if (input.proposedThisWeek >= input.loop.perWeek) {
    return { propose: false, hold: "budget_used" };
  }
  return {
    propose: true,
    carry: input.criteria.filter((c) => unmet(c.key)).map((c) => c.key),
  };
}
