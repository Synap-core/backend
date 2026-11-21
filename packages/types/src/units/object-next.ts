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

import type { ProcessHealth } from "../processes/health.js";
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

function fromHealth(health: ProcessHealth): ObjectNext | null {
  switch (health.state) {
    case "draft":
      return { action: "turn_on", reason: health.reason };
    case "config-error":
      return { action: "open", reason: health.reason };
    case "unresolved-failure":
      return { action: "see_failure", reason: health.reason };
    case "blocked-by-policy":
      return { action: "review", reason: health.reason };
    case "waiting-on-you":
      return {
        action: "answer",
        reason: health.reason,
        ...(health.sessionId ? { sessionId: health.sessionId } : {}),
      };
    case "running":
    case "paused":
    case "healthy":
    case "never-run":
    case "unknown":
      return null;
  }
}

function fromNextMove(move: StatusOfWorkNextMove): ObjectNext | null {
  const session = move.sessionId ? { sessionId: move.sessionId } : {};
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
    ...session,
  };
}

/**
 * The object's next step, or null when it needs nothing from the person.
 * Automations and playbooks read their health (a playbook first needs the
 * skills it uses enabled, unless it is still a draft or broken); things and
 * sessions read their next move. A kind with none of its facts read: null.
 */
export function objectNextOf(
  kind: string,
  facts: ObjectNextFacts
): ObjectNext | null {
  if (kind === "automation" || kind === "playbook") {
    const health = facts.health;
    if (
      kind === "playbook" &&
      (facts.skillsOff ?? 0) > 0 &&
      health?.state !== "draft" &&
      health?.state !== "config-error"
    ) {
      return { action: "enable", reason: "skills_off" };
    }
    return health ? fromHealth(health) : null;
  }
  return facts.nextMove ? fromNextMove(facts.nextMove) : null;
}
