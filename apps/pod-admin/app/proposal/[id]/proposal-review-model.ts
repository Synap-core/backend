/**
 * The review's marks — pure, so each is tested apart from the markup.
 *
 *   `reasonMark` — WHY the write waits, as ONE mark, and only when the reason
 *                  is particular to this change: its short label ("Possible
 *                  duplicate"), its sentence behind it (on press), toned by
 *                  the ladder's ONE table (`GOVERNANCE_REASON_RULE_REACH`).
 *                  "Asks by default" / "Always asks a person" are gone: a
 *                  pending proposal already waits on the person.
 *   `undoMark`   — what approving cannot take back. Undo is the default, so
 *                  an undoable change draws NOTHING (founder, 2026-10-23: "Can
 *                  be undone … we will not need to showcase that"); only the
 *                  pod's own `revertable: false` earns a mark.
 *
 * The change itself is `proposal-record-model.ts`.
 */

import { governanceReasonMark } from "@synap-core/types/proposals";
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
 * The reason a person decides, as one mark — only when it says something
 * particular about THIS change. A reason that only restates "this waits for
 * you" (the default, a rule of yours that asks, a human gate) has no label at
 * its one home (`GOVERNANCE_REASON_SHORT_LABELS`), and no mark is drawn: a
 * pending proposal is already waiting on the person. A stored sentence with no
 * code cannot be told apart either way, so it draws nothing.
 *
 * Tone: a floor the ladder never lets a rule widen (or an ambiguous code,
 * failing closed) is a warning; anything else is quiet.
 */
export function reasonMark(code: string | null | undefined): ReviewMark | null {
  const named = governanceReasonMark(code);
  if (!named) return null;
  const reach = Object.hasOwn(GOVERNANCE_REASON_RULE_REACH, named.code)
    ? GOVERNANCE_REASON_RULE_REACH[
        named.code as keyof typeof GOVERNANCE_REASON_RULE_REACH
      ]
    : undefined;
  const tone: ReviewTone =
    reach === "rule" || reach === "below" ? "default" : "warning";
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

/**
 * Whether the review reads at a document's width: it draws a document's
 * change, or a tool argument or record field that is prose, code or a text
 * diff (each one's `wide`, set by its own model). A review of short values
 * (a status move, an app asking for a key, a few names) stays at the
 * receiver's default width. The page reads this as `READS_WIDE_ATTR`.
 */
export function reviewReadsWide(drawn: {
  documentChanges: boolean;
  toolArguments: readonly { wide: boolean }[];
  records: readonly { fields: readonly { wide: boolean }[] }[];
}): boolean {
  return (
    drawn.documentChanges ||
    drawn.toolArguments.some((a) => a.wide) ||
    drawn.records.some((r) => r.fields.some((f) => f.wide))
  );
}
