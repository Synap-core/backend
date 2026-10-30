/**
 * New goal — the ONE draft the desk's island and the phone's form fill: its
 * fields and their defaults, why it cannot be sent yet (one set of refusal
 * words), the `tracks.start` input it becomes, and which projects may hold
 * the goal (with the one the form opens on).
 *
 *   - Done when holds NO criterion (a lasting goal) or 2 to 5
 *     (`goalCriteriaInputCheck` — the pod's own count and meaning rules).
 *   - A criterion a person writes is judged by a person unless they say
 *     otherwise (`DEFAULT_CRITERION_MEANING`).
 *   - The kind of work and the uncertainty are optional: picked here by a
 *     person they are sent CONFIRMED (`confirmKind`); left out, an agent may
 *     propose them later for a person to confirm (decision 4).
 *
 * Nothing is saved until the person presses the form's primary.
 *
 * PURE: no React, no DOM.
 */
import type {
  CriterionCheckMeaning,
  TrackUncertainty,
  TrackWorkKind,
} from "../units/index.js";
import {
  goalCriteriaInput,
  goalCriteriaInputCheck,
  type GoalCriterionDraft,
  type GoalCriterionInput,
} from "./criteria-input.js";

/**
 * What the person wrote. `C` lets a host carry its own row id beside each
 * criterion (a React key) — never sent.
 */
export interface NewGoalDraft<
  C extends GoalCriterionDraft = GoalCriterionDraft,
> {
  projectId: string | null;
  name: string;
  /** What done looks like — the end state. */
  endState: string;
  /** "Done when": none (a lasting goal) or 2 to 5. Rows with no words are ignored. */
  criteria: C[];
  workKind: TrackWorkKind | null;
  uncertainty: TrackUncertainty | null;
  /** Behind "Show more": when to stop. Blank lines are ignored. */
  dropConditions: string[];
}

/** A criterion a person writes is judged by a person unless they say otherwise. */
export const DEFAULT_CRITERION_MEANING: CriterionCheckMeaning = "judged";

/** A fresh draft — empty, on the project the form opens on (see {@link defaultGoalProjectId}). */
export function emptyNewGoal<C extends GoalCriterionDraft = GoalCriterionDraft>(
  init: { name?: string; projectId?: string | null } = {}
): NewGoalDraft<C> {
  return {
    projectId: init.projectId ?? null,
    name: init.name ?? "",
    endState: "",
    criteria: [],
    workKind: null,
    uncertainty: null,
    dropConditions: [],
  };
}

/** The criteria the person actually wrote (a row with no words is not a criterion yet). */
export function writtenCriteria<C extends GoalCriterionDraft>(draft: {
  criteria: readonly C[];
}): C[] {
  return draft.criteria.filter((c) => c.statement.trim().length > 0);
}

/** The refusal words of the New goal form — copy, one set for desk and phone. */
export const NEW_GOAL_REFUSAL = {
  name: "Give the goal a name.",
  project: "Choose the project it belongs to.",
} as const;

/**
 * Why the draft cannot start yet, in the person's words — `null` when it can.
 * Shown beside the disabled primary, never a silent grey button.
 */
export function newGoalRefusal(
  draft: NewGoalDraft<GoalCriterionDraft>
): string | null {
  if (!draft.name.trim()) return NEW_GOAL_REFUSAL.name;
  if (!draft.projectId) return NEW_GOAL_REFUSAL.project;
  return goalCriteriaInputCheck(goalCriteriaInput(writtenCriteria(draft)));
}

/** What `tracks.start` takes for a new goal. */
export interface NewGoalStartInput {
  projectId: string;
  name: string;
  endState?: string;
  criteria?: GoalCriterionInput[];
  dropConditions?: string[];
  workKind?: TrackWorkKind;
  uncertainty?: TrackUncertainty;
  confirmKind?: true;
}

/** The start door's input. Call only when {@link newGoalRefusal} is `null`. Absent fields are left out. */
export function newGoalStartInput(
  draft: NewGoalDraft<GoalCriterionDraft>
): NewGoalStartInput {
  const criteria = goalCriteriaInput(writtenCriteria(draft));
  const endState = draft.endState.trim();
  const drops = draft.dropConditions.map((d) => d.trim()).filter(Boolean);
  return {
    projectId: draft.projectId ?? "",
    name: draft.name.trim(),
    ...(endState ? { endState } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
    ...(drops.length > 0 ? { dropConditions: drops } : {}),
    ...(draft.workKind ? { workKind: draft.workKind } : {}),
    ...(draft.uncertainty ? { uncertainty: draft.uncertainty } : {}),
    // The person picked them here: confirmed, not the AI's proposal.
    ...(draft.workKind || draft.uncertainty
      ? { confirmKind: true as const }
      : {}),
  };
}

// ── which projects may hold a goal ──────────────────────────────────────────

/** The project fields the rule reads — structural, so the `projects.list` wire fits. */
export interface GoalProjectLike {
  id: string;
  /** `active` · `completed` · `archived` (`projects.list`); absent = not said, read as active. */
  status?: string | null;
  updatedAt?: string | Date | null;
}

/**
 * A project the New goal form offers: one that has not ended (`completed`,
 * `archived`). The ONE rule for the desk's and the phone's picker.
 *
 * The pod's start door (`startTrack`, synap-backend
 * `services/tracks/tracks-service.ts`) refuses only a project the person
 * cannot see (`loadVisibleProject`) or cannot write (`assertProjectWrite`) —
 * never by its status. So this rule only narrows the CHOICE (a goal filed in
 * an ended project would sit where nobody looks); the door's refusal stays
 * the authority on what may be written.
 */
export function projectMayHoldGoal(
  project: Pick<GoalProjectLike, "status">
): boolean {
  return project.status !== "completed" && project.status !== "archived";
}

const at = (v: string | Date | null | undefined): number => {
  if (!v) return 0;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * The project the form opens on: the current one when it may hold a goal,
 * else the most recently active project that may, else none (the person
 * chooses; the refusal says so).
 */
export function defaultGoalProjectId(
  projects: readonly GoalProjectLike[],
  currentProjectId?: string | null
): string | null {
  const open = projects.filter(projectMayHoldGoal);
  if (currentProjectId && open.some((p) => p.id === currentProjectId))
    return currentProjectId;
  const recent = [...open].sort((a, b) => at(b.updatedAt) - at(a.updatedAt))[0];
  return recent?.id ?? null;
}
