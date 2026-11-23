/**
 * An object's NEXT STEP as pod admin draws it: the step's mark (the pod's one
 * reading, `objectNextMark`) and at most one act. Pod admin runs the pod, so
 * the only act it takes in place is a lifecycle one (Turn on); a request to
 * decide opens its review here; any other step (an answer, a failure to look
 * at) is work, so it is one door to the app. A door the place already offers
 * (the object's own page and its "Open in app") is not drawn twice.
 *
 * Pure.
 */

import { objectNextMark, type ObjectNext } from "@synap-core/types/units";
import {
  resolveProcessHealthLabel,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../(admin)/components/status-pill";
import { unitTonePill } from "../../(admin)/components/status-tone";

export type NextStepAct =
  /** The governed status door, pressed in place. */
  | { kind: "turn_on"; objectKind: "automation" | "playbook"; id: string }
  /** The request that waits for a decision. */
  | { kind: "review"; proposalId: string }
  /** Where the work is done: the app. */
  | { kind: "in_app"; objectKind: string; id: string };

export interface NextStep {
  pill: { kind: StatusKind; label: string };
  /** The status read's own sentence (a thing's next move), when it has one. */
  line: string | null;
  act: NextStepAct | null;
  /** False when the step was not read, or could not be: a mark, no act. */
  measured: boolean;
}

/**
 * The next step of `object`, drawn in a list `row` or on the object's own
 * page. `undefined` (not read) and an unreadable move are `unmeasured`;
 * `null` (it needs nothing) draws nothing.
 */
export function nextStepOf(
  object: { kind: string; id: string },
  next: ObjectNext | null | undefined,
  where: "row" | "itsPage"
): NextStep | null {
  const mark = objectNextMark(next);
  if (!mark) return null;
  const pill = {
    kind: unitTonePill(mark.tone),
    label: mark.healthReason
      ? resolveProcessHealthLabel({ reason: mark.healthReason })
      : resolveStatusLabel(mark.state),
  };
  if (!next || mark.state === "unmeasured") {
    return { pill, line: null, act: null, measured: false };
  }
  return {
    pill,
    line: next.label?.trim() || null,
    act: actOf(object, next, where),
    measured: true,
  };
}

function actOf(
  object: { kind: string; id: string },
  next: ObjectNext,
  where: "row" | "itsPage"
): NextStepAct | null {
  if (
    next.action === "turn_on" &&
    (object.kind === "automation" || object.kind === "playbook")
  ) {
    // On its own page the header holds Turn on.
    return where === "row"
      ? { kind: "turn_on", objectKind: object.kind, id: object.id }
      : null;
  }
  if (next.action === "review" && next.proposalId) {
    return { kind: "review", proposalId: next.proposalId };
  }
  if (next.sessionId) {
    return { kind: "in_app", objectKind: "session", id: next.sessionId };
  }
  return where === "row"
    ? { kind: "in_app", objectKind: object.kind, id: object.id }
    : null;
}
