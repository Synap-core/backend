/**
 * THE NEXT STEP of an object: what it still needs from the person ("Turn on"
 * a draft automation, "Answer" what its session owes), projected from reads
 * the pod already makes. It reads, never stores: a process's health
 * (`deriveProcessHealth`), a thing's or a session's next move (the status
 * read's `nextMove`), and the skills a playbook uses that are not enabled.
 *
 * The wire carries an action TOKEN (`resolveActionLabel(action, "imperative")`
 * names the button) and a reason CODE, never words; a thing's or a session's
 * next move keeps its own `label`, as the status read gives it.
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
  /** Only a person can take it: it is theirs to do, a needs-you card. */
  personOnly: boolean;
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

/** Next moves that only the person reading can take. */
const PERSON_MOVES: ReadonlySet<string> = new Set([
  "owed_slot",
  "pending_proposal",
  "ready_to_close",
  "judge_review",
]);

function fromHealth(health: ProcessHealth): ObjectNext | null {
  switch (health.state) {
    case "draft":
      return { action: "turn_on", reason: health.reason, personOnly: true };
    case "config-error":
      return { action: "open", reason: health.reason, personOnly: true };
    case "unresolved-failure":
      return { action: "see_failure", reason: health.reason, personOnly: true };
    case "blocked-by-policy":
      return { action: "review", reason: health.reason, personOnly: true };
    case "waiting-on-you":
      return {
        action: "answer",
        reason: health.reason,
        personOnly: true,
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
      personOnly: false,
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
    personOnly: PERSON_MOVES.has(move.kind),
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
      return { action: "enable", reason: "skills_off", personOnly: true };
    }
    return health ? fromHealth(health) : null;
  }
  return facts.nextMove ? fromNextMove(facts.nextMove) : null;
}
