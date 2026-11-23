/**
 * The review's marks — pure, so each is tested apart from the markup.
 *
 *   `reasonMark` — WHY the write waits, as ONE mark, and only when the reason
 *                  is particular to this change: its short label ("Possible
 *                  duplicate"), its sentence behind it (on press), toned by
 *                  the ladder's ONE table (`GOVERNANCE_REASON_RULE_REACH`).
 *                  "Asks by default" / "Always asks a person" are gone: a
 *                  pending proposal already waits on the person.
 *   `undoMark`   — what approving cannot take back, read through the ONE
 *                  shared risk rule (`needsYouRisk`): an undoable change
 *                  draws NOTHING (founder, 2026-10-23: "Can be undone … we
 *                  will not need to showcase that"); `revertable: false` AND
 *                  an unmeasured one are marked (founder default D6, 16 Nov
 *                  2026: nobody checked, so nobody can promise an undo).
 *   `aboutObjects` / `madeRows` — the objects the request names, through the
 *                  pod's one reading (`proposalObjectsOf`): what it is about
 *                  until it lands, then each object it landed with its next
 *                  step (`landed[].next`).
 *
 * The change itself is `proposal-record-model.ts`.
 */

import {
  proposalObjectsOf,
  type ProposalLandedRole,
  type ProposalLandedRow,
  type ProposalObject,
} from "@synap-core/types/proposals/landed";
import type { ObjectNext, UnitTone } from "@synap-core/types/units";
import {
  resolveActionLabel,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import { nextStepOf, type NextStep } from "../../_lib/object/next-step-model";
import { objectReadsWide } from "../../_lib/object/object-width";
import { governanceReasonMark } from "@synap-core/types/proposals";
import { GOVERNANCE_REASON_RULE_REACH } from "@synap-core/types/trust-ladder";
import { needsYouRisk } from "@synap-core/types/needs-you";
import { proposalPageT } from "./copy";

/** One field of the pod's diff, read structurally. */
export interface ProposalChangeInput {
  path: string;
  label: string;
  operation: "create" | "update" | "delete" | "set";
  before?: unknown;
  after?: unknown;
  drift?: "unchanged" | "changed_since" | "unknown";
}

/** A mark's tone: the shared token (`UnitTone`), drawn by `app/_lib/tone.ts`. */
export type ReviewTone = UnitTone;

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
    reach === "rule" || reach === "below" ? "textSecondary" : "warning";
  return { tone, label: named.label, sentence: named.sentence };
}

/**
 * The one consequence worth a mark: approving cannot be undone. `revertable`
 * is the pod's answer for this proposal (`revertableForRow`); the rule is the
 * shared `needsYouRisk` (D6): `true` draws nothing, `false` AND unknown are
 * marked, because an unmeasured undo is not one anybody can promise.
 */
export function undoMark(
  revertable: boolean | null | undefined
): ReviewMark | null {
  const risk = needsYouRisk({ kind: "proposal", revertable });
  if (!risk) return null;
  const t = proposalPageT();
  return {
    tone: risk.tone,
    label: risk.label,
    // Unmeasured is said as unmeasured: nobody checked (S12).
    sentence: revertable === false ? t("undo.cannot") : t("undo.unknown"),
  };
}

/**
 * Whether the review reads at a document's width. First, as wide as the
 * object it creates or changes: the proposal's subject, or a record it draws,
 * is of a kind whose own page reads wide (`objectReadsWide`, the rule the
 * object page reads too), so a proposed document opens at its document's
 * width (founder, 2026-11-03). Then, what it draws: a document's change, or
 * a tool argument or record field that is prose, code or a text diff (each
 * one's `wide`, set by its own model). A review of short values (a status
 * move, an app asking for a key, a few names) stays at the receiver's
 * default width. The page reads this as `READS_WIDE_ATTR`.
 */
export function reviewReadsWide(drawn: {
  /** The kind the proposal is about (`proposalSubjectKind`). */
  subjectKind: string | null;
  documentChanges: boolean;
  toolArguments: readonly { wide: boolean }[];
  records: readonly {
    kind: string | null;
    fields: readonly { wide: boolean }[];
  }[];
}): boolean {
  return (
    objectReadsWide(drawn.subjectKind) ||
    drawn.records.some((r) => objectReadsWide(r.kind)) ||
    drawn.documentChanges ||
    drawn.toolArguments.some((a) => a.wide) ||
    drawn.records.some((r) => r.fields.some((f) => f.wide))
  );
}

/**
 * What the request is ABOUT while nothing of it has landed (a pending update's
 * object, a merge's survivor, a facet's entity): a door to each, at every
 * status but an applied one, whose objects are its "Made" rows.
 */
export function aboutObjects(row: ProposalLandedRow): ProposalObject[] {
  return proposalObjectsOf(row).filter((o) => o.role === null);
}

/** One object a proposal landed, as the read row carries it (`landed`). */
export interface LandedInput {
  id: string;
  kind: string;
  name: string | null;
  role: ProposalLandedRole;
  next?: ObjectNext | null;
}

export interface MadeRow {
  kind: string;
  id: string;
  title: string;
  /** What approving did to it, in the past mood ("Created"). */
  done: string;
  step: NextStep | null;
}

const VERB_OF_ROLE: Record<ProposalLandedRole, string> = {
  created: "create",
  updated: "update",
  linked: "link",
};

/** The "Made" rows: each landed object, its next step first among them. */
export function madeRows(
  landed: readonly LandedInput[] | undefined
): MadeRow[] {
  const rows = (landed ?? []).map((o) => ({
    kind: o.kind,
    id: o.id,
    title: o.name?.trim() || resolveObjectNoun(o.kind),
    done: resolveActionLabel(VERB_OF_ROLE[o.role], "past"),
    step: nextStepOf(o, o.next, "elsewhere"),
  }));
  return [...rows.filter((r) => r.step), ...rows.filter((r) => !r.step)];
}
