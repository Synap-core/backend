/**
 * An object's NEXT STEP, drawn: the one act it offers and the mark beside it,
 * from the pod's one projection (`objectNextOf`, `@synap-core/types/units`).
 * Read by the proposal page's "Made" rows (`landed[].next`) and by the object
 * pages that lead with it (`/open/<kind>/<id>`).
 *
 * Pure.
 */

import {
  PROCESS_HEALTH_REASONS,
  type ProcessHealthReason,
} from "@synap-core/types/processes";
import {
  resolveUnitState,
  type ObjectNext,
  type ObjectNextAction,
  type UnitStateInput,
} from "@synap-core/types/units";
import {
  resolveActionLabel,
  resolveProcessHealthLabel,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import type { ExitTarget } from "../../../lib/open-in";
import type { StatusKind } from "../../(admin)/components/status-pill";
import { unitTonePill } from "../../(admin)/components/status-tone";

/** What pressing the next step does. */
export type NextStepAct =
  /** The governed status door: an agent's key proposes, a person's applies. */
  | { kind: "turn_on"; objectKind: "automation" | "playbook"; id: string }
  | { kind: "door"; exit: ExitTarget };

export interface NextStep {
  /** The button's words, the vocabulary's imperative. */
  label: string;
  /** The status read's own sentence (a thing's next move), when it has one. */
  line: string | null;
  pill: { kind: StatusKind; label: string };
  act: NextStepAct;
}

/** Each action's state, read through the one unit-state derivation. */
const UNIT_OF_ACTION: Record<ObjectNextAction, UnitStateInput> = {
  turn_on: { everStarted: false },
  enable: { waitingOnYou: true },
  see_failure: { failed: true },
  review: { pendingDecisions: 1 },
  answer: { waitingOnYou: true },
  open: { waitingOnYou: true },
};

const HEALTH_REASONS: ReadonlySet<string> = new Set(PROCESS_HEALTH_REASONS);

function pillOf(next: ObjectNext): NextStep["pill"] {
  const view = resolveUnitState(
    next.reason === "config_invalid"
      ? { failed: true }
      : UNIT_OF_ACTION[next.action]
  );
  return {
    kind: unitTonePill(view.tone),
    label: HEALTH_REASONS.has(next.reason)
      ? resolveProcessHealthLabel({
          reason: next.reason as ProcessHealthReason,
        })
      : resolveStatusLabel(view.state),
  };
}

/**
 * The next step of `object`, or null when it needs nothing (or was not read).
 * Turning on is pressed in place; any other step is a door: to the session
 * that owes it, else to the object's page, or, on that page itself, to the
 * app where the work is done.
 */
export function nextStepOf(
  object: { kind: string; id: string },
  next: ObjectNext | null | undefined,
  where: "elsewhere" | "itsPage"
): NextStep | null {
  if (!next) return null;
  const act: NextStepAct =
    next.action === "turn_on" &&
    (object.kind === "automation" || object.kind === "playbook")
      ? { kind: "turn_on", objectKind: object.kind, id: object.id }
      : {
          kind: "door",
          exit: next.sessionId
            ? { kind: "object", objectKind: "session", id: next.sessionId }
            : {
                kind: where === "itsPage" ? "objectInApp" : "object",
                objectKind: object.kind,
                id: object.id,
              },
        };
  return {
    label: resolveActionLabel(next.action, "imperative"),
    line: next.label?.trim() || null,
    pill: pillOf(next),
    act,
  };
}
