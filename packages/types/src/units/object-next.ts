/**
 * THE NEXT STEP of an object ("Turn on" a draft automation, "Answer" what its
 * session owes), projected from facts the pod already reads; it stores
 * nothing. An action TOKEN (`resolveActionLabel(action, "imperative")` names
 * the button) and a reason CODE, never words; a thing's or a session's next
 * move keeps the status read's own `label`. Whether it is a needs-you item is
 * the needs-you rule's call (`units/needs-you.ts`), not this one's.
 *
 * Pure.
 */

import {
  PROCESS_HEALTH_REASONS,
  type ProcessHealth,
  type ProcessHealthReason,
} from "../processes/health.js";
import {
  resolveUnitState,
  type UnitStateInput,
  type UnitStateView,
} from "./state.js";
import type { StatusOfWorkNextMove } from "./status-of.js";

/** The action tokens a next step uses, each one of the vocabulary's verbs. */
export const OBJECT_NEXT_ACTIONS = [
  "turn_on",
  "enable",
  "see_failure",
  "review",
  "answer",
  "open",
] as const;
export type ObjectNextAction = (typeof OBJECT_NEXT_ACTIONS)[number];

export interface ObjectNext {
  action: ObjectNextAction;
  /** Why: the process health reason, `skills_off`, or the next move's kind. */
  reason: string;
  /** Where it is taken when not on the object: the session that owes it. */
  sessionId?: string;
  /** A `review` move: the request that waits for a decision. */
  proposalId?: string;
  /** A thing's or a session's next move, in the status read's words. */
  label?: string;
}

/** What the pod read about the object; a fact that was not read is absent. */
export interface ObjectNextFacts {
  /** Automations and playbooks: their health over the run ledger. */
  health?: ProcessHealth;
  /** Playbooks: how many skills it uses are not enabled for its owner. */
  skillsOff?: number;
  /** Things and sessions: their next move (`statusOf`). */
  nextMove?: StatusOfWorkNextMove;
}

/** Each health reason's next step; total over the reasons, so a new one must be placed. */
const ACTION_OF_HEALTH: Record<ProcessHealthReason, ObjectNextAction | null> = {
  draft: "turn_on",
  config_invalid: "open",
  latest_failed: "see_failure",
  blocked_by_policy: "review",
  waiting_on_you: "answer",
  running: null,
  running_after_failure: null,
  paused: null,
  archived: null,
  healthy: null,
  latest_unresolved: null,
  never_run: null,
  not_enough_activity: null,
};

function fromHealth(health: ProcessHealth): ObjectNext | null {
  const action = ACTION_OF_HEALTH[health.reason];
  if (!action) return null;
  return {
    action,
    reason: health.reason,
    ...(health.sessionId ? { sessionId: health.sessionId } : {}),
  };
}

function fromNextMove(move: StatusOfWorkNextMove): ObjectNext | null {
  const where = {
    ...(move.sessionId ? { sessionId: move.sessionId } : {}),
    ...(move.proposalId ? { proposalId: move.proposalId } : {}),
  };
  if (move.kind === "unknown") {
    return {
      action: "open",
      reason: move.kind,
      label: move.label,
    };
  }
  if (move.actor !== "user") return null;
  const action: ObjectNextAction =
    move.kind === "owed_slot"
      ? "answer"
      : move.kind === "pending_proposal"
        ? "review"
        : "open";
  return {
    action,
    reason: move.kind,
    label: move.label,
    ...where,
  };
}

/**
 * The object's next step, or null when it needs nothing from the person.
 * Automations and playbooks read their health (a playbook first needs the
 * skills it uses enabled, unless it is still a draft or broken); things and
 * sessions read their next move; a defined cell needs nothing more (its
 * placing is the person's own choice). A kind with none of its facts read: null.
 */
export function objectNextOf(
  kind: string,
  facts: ObjectNextFacts
): ObjectNext | null {
  if (kind === "cell") return null;
  if (kind === "automation" || kind === "playbook") {
    const health = facts.health;
    if (
      kind === "playbook" &&
      (facts.skillsOff ?? 0) > 0 &&
      health?.reason !== "draft" &&
      health?.reason !== "config_invalid"
    ) {
      return { action: "enable", reason: "skills_off" };
    }
    return health ? fromHealth(health) : null;
  }
  return facts.nextMove ? fromNextMove(facts.nextMove) : null;
}

/** The unit state of each step, read through the one derivation. */
const UNIT_OF_ACTION: Record<ObjectNextAction, UnitStateInput> = {
  turn_on: { everStarted: false },
  enable: { waitingOnYou: true },
  see_failure: { failed: true },
  review: { pendingDecisions: 1 },
  answer: { waitingOnYou: true },
  open: { waitingOnYou: true },
};

const HEALTH_REASONS: ReadonlySet<string> = new Set(PROCESS_HEALTH_REASONS);

/** A next step's mark, as tokens: the host names it through the vocabulary. */
export interface ObjectNextMark extends UnitStateView {
  /** Set when the step comes from a process's health: its words name it. */
  healthReason?: ProcessHealthReason;
}

/**
 * THE mark of an object's next step. `undefined` (not read) and a move the
 * status read could not make (`unknown`) are `unmeasured`, never your turn;
 * `null` (it needs nothing) has no mark. A broken definition is `failed`.
 */
export function objectNextMark(
  next: ObjectNext | null | undefined
): ObjectNextMark | null {
  if (next === null) return null;
  if (next === undefined || next.reason === "unknown") {
    return resolveUnitState({ unreadable: true });
  }
  const view = resolveUnitState(
    next.reason === "config_invalid"
      ? { failed: true }
      : UNIT_OF_ACTION[next.action]
  );
  return HEALTH_REASONS.has(next.reason)
    ? { ...view, healthReason: next.reason as ProcessHealthReason }
    : view;
}
