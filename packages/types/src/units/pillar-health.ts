/**
 * PILLAR HEALTH — the pure half (goals / pillars / health contract, founder
 * validated 2026-11-12).
 *
 * A PILLAR is a space a project uses (`project --uses--> workspace`, with the
 * pillar's line in `metadata.purpose`); never an entity kind (the Content OS
 * `pillar` kind and Brand's "content pillars" are other things). Goals say
 * which pillars they advance (`track --advances--> workspace`); at most one
 * is a goal's PRIMARY pillar.
 *
 * Health is DERIVED, never stored: the WORST state among a pillar's primary
 * goals, with the counts that made it, never an average. A goal counts FULLY
 * in its primary pillar only; in the other pillars it advances it is listed
 * with its own mark and changes nothing. A dropped goal, or one closed without
 * being met, leaves the roll-up (and the list).
 *
 * The states, worst first (each never green unless `moving`):
 *   no_active_goal   no live primary goal (all ended, or none) — never green;
 *   stalled          live primary goals, every one paused;
 *   unproven         every non-paused live primary goal is an unvalidated bet;
 *   needs_attention  a paused goal or an unvalidated bet among them;
 *   moving           the rest.
 * Staleness (nothing moved in the window) is its OWN signal (`stale`), never
 * folded into the state.
 *
 * PURE and dependency-free: the pod derives it (`services/projects/
 * pillar-health.ts`), and the browser and Relay import the same types.
 */

import { trackStatusCategory } from "./track-status.js";

/** The health states, worst first — the order {@link worstPillarState} reads. */
export const PILLAR_HEALTH_STATES = [
  "no_active_goal",
  "stalled",
  "unproven",
  "needs_attention",
  "moving",
] as const;
export type PillarHealthState = (typeof PILLAR_HEALTH_STATES)[number];

export interface PillarGoalCounts {
  /** Live primary goals that are not paused. */
  open: number;
  /** Primary goals closed as met or partly met. */
  validated: number;
  /** Open primary goals that are unvalidated bets ({@link isGoalBet}). */
  bet: number;
  /** Paused primary goals. */
  paused: number;
}

export interface PillarHealth {
  state: PillarHealthState;
  counts: PillarGoalCounts;
  /** Nothing moved in the pillar within the window — its own signal. */
  stale: boolean;
  /** One line for an agent; a surface draws the state's label and the counts. */
  reason: string;
  /**
   * Distinct work sessions on the pillar's primary goals (filed in, serving,
   * or spawned under one of them; sub-goals included), each counted once.
   * Absent when the pod did not count them.
   */
  sessions?: number;
}

/** Lifecycle categories a pillar's indicator counts things in. */
export interface PillarIndicatorCounts {
  open: number;
  active: number;
  paused: number;
  done: number;
  lost: number;
}

export interface PillarIndicatorKind {
  /** The kind's slug (its words come from the vocabulary door). */
  kind: string;
  byCategory: PillarIndicatorCounts;
  /** Things past their status's `stuckAfterDays`. */
  stuck: number;
}

/**
 * What the pillar's own work looks like: the things of a kind with a DECLARED
 * lifecycle, in the project and the space. `declared: false` = no such kind
 * here — a surface says "no indicator declared"; an indicator is never
 * invented for a space that declares none.
 */
export interface PillarIndicator {
  declared: boolean;
  kinds: PillarIndicatorKind[];
}

export type PillarGoalRole = "primary" | "contributing";

export interface PillarGoal {
  goalId: string;
  name: string;
  status: string;
  verdict: string | null;
  role: PillarGoalRole;
  isBet: boolean;
}

export interface Pillar {
  workspaceId: string;
  workspaceName: string;
  /** What the project needs from the space (`uses` `metadata.purpose`). */
  purpose: string | null;
  /** Always true: only a space the project uses is a pillar. */
  isLinked: true;
  health: PillarHealth;
  indicator: PillarIndicator;
  goals: PillarGoal[];
}

export interface ProjectMainGoal {
  id: string;
  name: string;
  status: string;
}

export interface ProjectRootHealth {
  /** The worst pillar state; `no_active_goal` when the project has no pillar. */
  state: PillarHealthState;
  pillarsMoving: number;
  pillarsTotal: number;
  /** Pillars with no live primary goal. */
  pillarsEmpty: number;
}

export interface ProjectPillars {
  projectId: string;
  mainGoal: ProjectMainGoal | null;
  pillars: Pillar[];
  rootHealth: ProjectRootHealth;
}

/** The facts of a goal the health rules read. */
export interface PillarGoalFacts {
  status: string;
  verdict?: string | null;
  workKind?: string | null;
  uncertainty?: string | null;
}

/** Uncertainty levels at which the way to the end is not known yet. */
export const BET_UNCERTAINTY_LEVELS = [
  "complex",
  "chaotic",
  "unknown",
] as const;

/**
 * An UNVALIDATED BET: a goal with no verdict yet whose way is not known —
 * its uncertainty is complex, chaotic or unknown, or it is an investigation
 * (finding out whether something holds). Read from the goal's own stored
 * fields (decision 4: `workKind`, `uncertainty`); a goal whose uncertainty
 * nobody stated is not called a bet.
 */
export function isGoalBet(goal: PillarGoalFacts): boolean {
  if (goal.verdict) return false;
  return (
    goal.workKind === "investigation" ||
    (BET_UNCERTAINTY_LEVELS as readonly (string | null | undefined)[]).includes(
      goal.uncertainty
    )
  );
}

/** Verdicts that VALIDATE a goal (it was met, wholly or partly). */
export const VALIDATING_VERDICTS = ["met", "partly_met"] as const;

/**
 * Does this goal count in a roll-up? A live goal (open, active, paused) or
 * one closed as met or partly met. A dropped goal, or one closed not met or
 * retired, has left.
 */
export function goalInPillarRollup(goal: PillarGoalFacts): boolean {
  const category = trackStatusCategory(goal.status);
  if (category === "open" || category === "active" || category === "paused") {
    return true;
  }
  return (
    category === "done" &&
    (VALIDATING_VERDICTS as readonly (string | null | undefined)[]).includes(
      goal.verdict
    )
  );
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * A pillar's health from its PRIMARY goals (contributing ones never reach
 * here). Goals that left the roll-up ({@link goalInPillarRollup}) are skipped.
 */
export function derivePillarHealth(
  primaryGoals: readonly PillarGoalFacts[],
  stale: boolean
): PillarHealth {
  const counts: PillarGoalCounts = { open: 0, validated: 0, bet: 0, paused: 0 };
  for (const g of primaryGoals) {
    if (!goalInPillarRollup(g)) continue;
    const category = trackStatusCategory(g.status);
    if (category === "done") counts.validated++;
    else if (category === "paused") counts.paused++;
    else {
      counts.open++;
      if (isGoalBet(g)) counts.bet++;
    }
  }
  let state: PillarHealthState;
  let reason: string;
  if (counts.open === 0 && counts.paused === 0) {
    state = "no_active_goal";
    reason =
      counts.validated > 0
        ? `No live goal: ${plural(counts.validated, "goal was", "goals were")} met, none is running.`
        : "No live goal names this pillar as its primary pillar.";
  } else if (counts.open === 0) {
    state = "stalled";
    reason = `Every goal is paused (${plural(counts.paused, "goal", "goals")}).`;
  } else if (counts.bet === counts.open) {
    state = "unproven";
    reason = `Only unvalidated bets are running (${plural(counts.bet, "bet", "bets")}).`;
  } else if (counts.paused > 0 || counts.bet > 0) {
    state = "needs_attention";
    const parts = [
      ...(counts.paused > 0
        ? [`${plural(counts.paused, "goal", "goals")} paused`]
        : []),
      ...(counts.bet > 0
        ? [`${plural(counts.bet, "unvalidated bet", "unvalidated bets")}`]
        : []),
    ];
    reason = `${plural(counts.open, "goal", "goals")} running; ${parts.join(", ")}.`;
  } else {
    state = "moving";
    reason = `${plural(counts.open, "goal", "goals")} running, none paused, none an unvalidated bet.`;
  }
  return { state, counts, stale, reason };
}

/** The worse of two states (the earlier in {@link PILLAR_HEALTH_STATES}). */
export function worstPillarState(
  a: PillarHealthState,
  b: PillarHealthState
): PillarHealthState {
  return PILLAR_HEALTH_STATES.indexOf(a) <= PILLAR_HEALTH_STATES.indexOf(b)
    ? a
    : b;
}

/** The project's root: the worst pillar, with counts; no pillar ⇒ no_active_goal. */
export function deriveProjectRootHealth(
  pillars: readonly Pick<Pillar, "health">[]
): ProjectRootHealth {
  let state: PillarHealthState =
    pillars.length === 0 ? "no_active_goal" : "moving";
  let pillarsMoving = 0;
  let pillarsEmpty = 0;
  for (const p of pillars) {
    state = worstPillarState(state, p.health.state);
    if (p.health.state === "moving") pillarsMoving++;
    if (p.health.state === "no_active_goal") pillarsEmpty++;
  }
  return { state, pillarsMoving, pillarsTotal: pillars.length, pillarsEmpty };
}
