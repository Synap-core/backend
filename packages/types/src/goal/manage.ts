/**
 * The goal's MANAGEMENT doors — what a person may change on a goal after it
 * started, as data both surfaces read (Additions A3):
 *
 *   - which doors the goal page's menu offers this viewer (`goalManageDoors`):
 *     Edit goal · Add someone · Confirm kind (only while the AI's kind waits
 *     for a person) · Repeat runs (the loop);
 *   - the edit draft and the `tracks.setDirection` patch it becomes — only
 *     the fields that changed, each WHOLE (`goalEditDraftOf`,
 *     `goalDirectionPatch`), checked by the same criteria rule as New goal;
 *   - adding someone (`tracks.changeParticipants` op `add`): a delegate needs
 *     what they commit to; handing a goal to ANOTHER agent is the pod's
 *     hand-off, approved by a person (the answer is `proposed`);
 *   - the loop on/off and its weekly budget (`loop` on setDirection);
 *   - "Make it a goal" for a goal / objective / okr entity — the rule is the
 *     pod's own `canConvertToGoal` (`@synap-core/types/units`).
 *
 * The page stays a reading page: these are menu doors and an edit sheet,
 * never fields drawn on the page itself (progressive disclosure).
 *
 * PURE: no React.
 */
import {
  canConvertToGoal,
  GOAL_LOOP_DEFAULT_PER_WEEK,
  GOAL_LOOP_MAX_PER_WEEK,
  isTrackClosed,
  type CriterionCheckMeaning,
  type GoalConvertibleEntity,
  type GoalLoopSettings,
  type TrackParticipant,
  type TrackUncertainty,
  type TrackWorkKind,
} from "../units/index.js";
import {
  goalCriteriaInput,
  goalCriteriaInputCheck,
  type GoalCriterionDraft,
  type GoalCriterionInput,
} from "./criteria-input.js";
import { writtenCriteria } from "./new-goal.js";
import { viewerMayStaff, type GoalLike, type GoalViewer } from "./model.js";

/** Copy, not stored values — the doors' words, one set for desk and phone. */
export const GOAL_MANAGE_COPY = {
  edit: "Edit goal",
  addSomeone: "Add someone",
  confirmKind: "Confirm kind",
  repeatRuns: "Repeat runs",
  makeItAGoal: "Make it a goal",
  commitmentNeeded: "Say what they commit to.",
  nobodyChosen: "Choose who to add.",
  nothingChanged: "Nothing changed yet.",
} as const;

// ── which doors ─────────────────────────────────────────────────────────────

export type GoalManageDoorKey =
  "edit" | "add_someone" | "confirm_kind" | "repeat_runs";

export interface GoalManageDoor {
  key: GoalManageDoorKey;
  label: string;
}

/**
 * The menu doors this viewer may use: the goal's owner or judge, a person,
 * on an open goal. "Confirm kind" only while a kind or uncertainty waits for
 * a person's confirmation; "Repeat runs" only on a goal with criteria (the
 * loop proposes runs while a required criterion is unmet).
 */
export function goalManageDoors(
  goal: GoalLike,
  viewer: GoalViewer
): GoalManageDoor[] {
  if (isTrackClosed(goal) || !viewerMayStaff(goal, viewer)) return [];
  const doors: GoalManageDoor[] = [
    { key: "edit", label: GOAL_MANAGE_COPY.edit },
    { key: "add_someone", label: GOAL_MANAGE_COPY.addSomeone },
  ];
  if ((goal.workKind || goal.uncertainty) && !goal.kindConfirmedBy) {
    doors.push({ key: "confirm_kind", label: GOAL_MANAGE_COPY.confirmKind });
  }
  if (goal.criteria.length > 0)
    doors.push({ key: "repeat_runs", label: GOAL_MANAGE_COPY.repeatRuns });
  return doors;
}

// ── edit ────────────────────────────────────────────────────────────────────

/** What the edit sheet holds — New goal's fields minus the name and project. */
export interface GoalEditDraft<
  C extends GoalCriterionDraft = GoalCriterionDraft,
> {
  endState: string;
  criteria: C[];
  dropConditions: string[];
  workKind: TrackWorkKind | null;
  uncertainty: TrackUncertainty | null;
}

/** The sheet opened on the goal as it stands (each criterion keeps its key). */
export function goalEditDraftOf(goal: GoalLike): GoalEditDraft {
  return {
    endState: goal.endState ?? "",
    criteria: goal.criteria.map((c) => ({
      key: c.key,
      statement: c.statement,
      meaning: c.meaning as CriterionCheckMeaning,
    })),
    dropConditions: [...goal.dropConditions],
    workKind: (goal.workKind as TrackWorkKind | null) ?? null,
    uncertainty: (goal.uncertainty as TrackUncertainty | null) ?? null,
  };
}

/** What `tracks.setDirection` takes for a goal's content — each field whole; `null` clears. */
export interface GoalDirectionPatch {
  endState?: string | null;
  criteria?: GoalCriterionInput[] | null;
  dropConditions?: string[] | null;
  workKind?: TrackWorkKind | null;
  uncertainty?: TrackUncertainty | null;
  confirmKind?: true;
  loop?: { on: boolean; perWeek?: number } | null;
}

/** Why the edit cannot be saved, in words — `null` when it can (same criteria rule as New goal). */
export function goalEditRefusal(
  goal: GoalLike,
  draft: GoalEditDraft
): string | null {
  const check = goalCriteriaInputCheck(
    goalCriteriaInput(writtenCriteria(draft))
  );
  if (check) return check;
  return goalDirectionPatch(goal, draft)
    ? null
    : GOAL_MANAGE_COPY.nothingChanged;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The patch the edit sheet sends: only the fields that changed. A kind or
 * uncertainty a person picks here is CONFIRMED (decision 4). `null` = nothing
 * changed.
 */
export function goalDirectionPatch(
  goal: GoalLike,
  draft: GoalEditDraft
): GoalDirectionPatch | null {
  const patch: GoalDirectionPatch = {};
  const endState = draft.endState.trim() || null;
  if (endState !== (goal.endState?.trim() || null)) patch.endState = endState;

  const before = goal.criteria.map((c) => [
    c.key,
    c.statement.trim(),
    c.meaning,
  ]);
  const criteria = goalCriteriaInput(writtenCriteria(draft));
  if (
    !same(
      before,
      criteria.map((c) => [c.key, c.statement, c.checkKind])
    )
  ) {
    patch.criteria = criteria.length > 0 ? criteria : null;
  }

  const drops = draft.dropConditions.map((d) => d.trim()).filter(Boolean);
  if (!same(drops, goal.dropConditions.map((d) => d.trim()).filter(Boolean))) {
    patch.dropConditions = drops.length > 0 ? drops : null;
  }

  const kindChanged = draft.workKind !== (goal.workKind ?? null);
  const uncertaintyChanged = draft.uncertainty !== (goal.uncertainty ?? null);
  if (kindChanged) patch.workKind = draft.workKind;
  if (uncertaintyChanged) patch.uncertainty = draft.uncertainty;
  if (
    (kindChanged || uncertaintyChanged) &&
    (draft.workKind || draft.uncertainty)
  )
    patch.confirmKind = true;

  return Object.keys(patch).length > 0 ? patch : null;
}

/** "Confirm kind": a person confirms the kind and uncertainty the AI proposed, unchanged. */
export const CONFIRM_KIND_PATCH: GoalDirectionPatch = { confirmKind: true };

// ── the loop ────────────────────────────────────────────────────────────────

export interface GoalLoopView {
  on: boolean;
  perWeek: number;
  /** The budget's bounds, for the stepper. */
  min: 1;
  max: number;
}

/** The loop as the "Repeat runs" sheet shows it — a goal read without one is OFF. */
export function goalLoopView(goal: {
  loop?: GoalLoopSettings | null;
}): GoalLoopView {
  return {
    on: goal.loop?.on === true,
    perWeek: goal.loop?.perWeek ?? GOAL_LOOP_DEFAULT_PER_WEEK,
    min: 1,
    max: GOAL_LOOP_MAX_PER_WEEK,
  };
}

/** The setDirection patch for the loop. Switching it on again is "try again" (the pod restarts its count). */
export function goalLoopPatch(
  on: boolean,
  perWeek?: number
): GoalDirectionPatch {
  if (!on) return { loop: { on: false } };
  const budget =
    perWeek === undefined
      ? undefined
      : Math.min(Math.max(Math.round(perWeek), 1), GOAL_LOOP_MAX_PER_WEEK);
  return {
    loop: { on: true, ...(budget !== undefined ? { perWeek: budget } : {}) },
  };
}

// ── who's on it: add, remove ────────────────────────────────────────────────

/** The roles a person adds (the owner is the goal's from birth). */
export type GoalAddableRole = "judge" | "delegate" | "integrator";

export interface GoalParticipantDraft {
  principalId: string | null;
  role: GoalAddableRole;
  /** What a delegate commits to. */
  commitment: string;
}

/** The `changeParticipants` change for an add. */
export interface GoalParticipantAddChange {
  op: "add";
  principalId: string;
  role: GoalAddableRole;
  commitment?: string;
}

/** Why the add cannot be sent yet — `null` when it can. */
export function goalParticipantAddRefusal(
  draft: GoalParticipantDraft
): string | null {
  if (!draft.principalId) return GOAL_MANAGE_COPY.nobodyChosen;
  if (draft.role === "delegate" && !draft.commitment.trim())
    return GOAL_MANAGE_COPY.commitmentNeeded;
  return null;
}

/** The change to send. Call only when {@link goalParticipantAddRefusal} is `null`. */
export function goalParticipantAddChange(
  draft: GoalParticipantDraft
): GoalParticipantAddChange {
  const commitment = draft.commitment.trim();
  return {
    op: "add",
    principalId: draft.principalId ?? "",
    role: draft.role,
    ...(commitment ? { commitment } : {}),
  };
}

/**
 * The participant rows this viewer may remove: anyone but the owner, for the
 * goal's owner or judge (the pod keeps the owner; it refuses the rest).
 */
export function goalRemovableParticipants(
  goal: GoalLike,
  viewer: GoalViewer
): TrackParticipant[] {
  if (isTrackClosed(goal) || !viewerMayStaff(goal, viewer)) return [];
  return (goal.participants ?? []).filter((p) => p.role !== "owner");
}

// ── Make it a goal ──────────────────────────────────────────────────────────

/**
 * "Make it a goal" on an object page's action row: only a goal / objective /
 * okr entity never made into a goal — the pod's own rule, re-exported so a
 * host asks this folder for every goal door.
 */
export function mayMakeItAGoal(entity: GoalConvertibleEntity): boolean {
  return canConvertToGoal(entity);
}
