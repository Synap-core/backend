/**
 * The review's marks — pure, so each is tested apart from the markup.
 *
 *   `reasonMark` — WHY the write waits, as ONE mark: the reason's short label
 *                  ("Possible duplicate"), its sentence behind it (on press),
 *                  toned by whether one of your rules could ever let it
 *                  through (the ladder's ONE table,
 *                  `GOVERNANCE_REASON_RULE_REACH`).
 *   `undoMark`   — what approving cannot take back. Undo is the default, so
 *                  an undoable change draws NOTHING (founder, 2026-10-23: "Can
 *                  be undone … we will not need to showcase that"); only the
 *                  pod's own `revertable: false` earns a mark.
 *
 * The change itself is `proposal-record-model.ts`.
 */

import {
  GOVERNANCE_REASON_UNNAMED_LABEL,
  governanceReasonMark,
} from "@synap-core/types/proposals";
import { GOVERNANCE_REASON_RULE_REACH } from "@synap-core/types/trust-ladder";

/** One field of the pod's diff, read structurally. */
export interface ProposalChangeInput {
  path: string;
  label: string;
  operation: "create" | "update" | "delete" | "set";
  before?: unknown;
  after?: unknown;
  drift?: "unchanged" | "changed_since" | "unknown";
}

export type ReviewTone = "warning" | "primary" | "default" | "success";

/** A state, said as a short label; its sentence is disclosed on press. */
export interface ReviewMark {
  tone: ReviewTone;
  label: string;
  sentence: string;
}

/**
 * The reason a person decides, as one mark. `policySentence` is the policy's
 * words the page already resolved (`proposalWhy`) — for a legacy row that
 * stored only its sentence, the mark is the unnamed one with that sentence.
 * No reason at all → no mark.
 *
 * Tone: a floor (or an ambiguous code, failing closed as the ladder does) is
 * a warning; a rule of yours is primary; the default is quiet.
 */
export function reasonMark(
  code: string | null | undefined,
  policySentence: string | undefined
): ReviewMark | null {
  const named = governanceReasonMark(code);
  if (!named) {
    return policySentence
      ? {
          tone: "default",
          label: GOVERNANCE_REASON_UNNAMED_LABEL,
          sentence: policySentence,
        }
      : null;
  }
  const reach = Object.hasOwn(GOVERNANCE_REASON_RULE_REACH, named.code)
    ? GOVERNANCE_REASON_RULE_REACH[
        named.code as keyof typeof GOVERNANCE_REASON_RULE_REACH
      ]
    : undefined;
  const tone: ReviewTone =
    reach === "rule" ? "primary" : reach === "below" ? "default" : "warning";
  return { tone, label: named.label, sentence: named.sentence };
}

/**
 * The one consequence worth a mark: approving cannot be undone. `revertable`
 * is the pod's answer for this proposal (`revertableForRow`); `true` and
 * unknown draw nothing — undo is the default, and an unknown is not promised.
 */
export function undoMark(
  revertable: boolean | null | undefined
): ReviewMark | null {
  if (revertable !== false) return null;
  return {
    tone: "warning",
    label: "Can't be undone",
    sentence: "Approving applies it now, and it cannot be undone from here.",
  };
}
