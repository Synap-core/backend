/**
 * THE RISK MARK of one needs-you item — the rule every surface (Relay's
 * one-card queue, the browser's Inbox, the web ask card) draws an item's risk
 * by. Pure, and a leaf: it imports nothing from `../ask` (the ask card reads
 * it at load, `ASK_COPY`, so an import back would be an ESM cycle). Returns
 * tone and glyph TOKEN NAMES (`UnitTone`, `UnitGlyph`), never a colour. The
 * ask's swipe gate built on it is `askSwipeAnswer` (`../ask/card.ts`).
 *
 * {@link needsYouRisk} replaced two derivations that answered the same
 * question two ways: `askRiskView` (asks; it painted `danger`, a tone no
 * palette has — `UnitTone` says `error`) and relay's `irreversibleMark`
 * (proposals, `card-marks.ts`). One item, one mark, at most:
 *
 *   `high`         — the asker said `risk: 'high'`.            error · alert
 *   `irreversible` — what the answer does cannot be undone:     textSecondary · lock
 *                    an ask that says `reversible: false`, or a
 *                    request whose revertability is not `true`
 *                    (UNMEASURED is marked too: nobody checked,
 *                    so nobody can promise an undo).
 *   `medium`       — the asker said `risk: 'medium'`.          warning · alert
 *
 * Precedence is that order: a declared high risk is the loudest fact; the
 * lock is a FACT about the act and outranks a medium judgement. Low or
 * absent draws nothing (OMIT).
 *
 * A request's IMPACT is not read here: it already wears its intent mark
 * (`resolveProposalIntent`: a removal is error · trash, a governance change
 * error · shield). Drawing it again as a risk chip would be two marks for one
 * fact.
 *
 * WHEN a mark is drawn (only while a verdict is on offer, never after a
 * rejection) stays the surface's call; WHAT it says is this file's.
 */

import { IRREVERSIBLE_MARK_LABEL } from "../proposals/intent.js";
import type { UnitGlyph, UnitTone } from "../units/state.js";

export const NEEDS_YOU_RISK_LEVELS = [
  "high",
  "irreversible",
  "medium",
] as const;
export type NeedsYouRiskLevel = (typeof NEEDS_YOU_RISK_LEVELS)[number];

export interface NeedsYouRiskMark {
  level: NeedsYouRiskLevel;
  tone: UnitTone;
  glyph: UnitGlyph;
  /** The chip word: a mark, short enough to sit beside the glyph. */
  label: string;
}

/** The words of each mark, once. Product copy; the lock's words are the request mark's own constant. */
export const NEEDS_YOU_RISK_LABELS: Readonly<
  Record<NeedsYouRiskLevel, string>
> = {
  high: "High risk",
  irreversible: IRREVERSIBLE_MARK_LABEL,
  medium: "Medium risk",
};

const MARKS: Readonly<
  Record<NeedsYouRiskLevel, { tone: UnitTone; glyph: UnitGlyph }>
> = {
  high: { tone: "error", glyph: "alert" },
  irreversible: { tone: "textSecondary", glyph: "lock" },
  medium: { tone: "warning", glyph: "alert" },
};

function mark(level: NeedsYouRiskLevel): NeedsYouRiskMark {
  return { level, ...MARKS[level], label: NEEDS_YOU_RISK_LABELS[level] };
}

/** The ask fields the risk reads — structural, so any ask (or snapshot) fits. */
export interface NeedsYouRiskAsk {
  risk?: unknown;
  /** Whether what the answer does can be undone. Absent = not said. */
  reversible?: unknown;
}

/**
 * A needs-you item as the risk reads it: an owed ask, or a pending request
 * (`proposal`) with the pod's measured revertability (`revertableForRow`).
 */
export type NeedsYouRiskItem =
  | { kind: "ask"; ask: NeedsYouRiskAsk | null | undefined }
  | { kind: "proposal"; revertable?: boolean | null };

/** The item's ONE risk mark, or `null` when it draws nothing. */
export function needsYouRisk(item: NeedsYouRiskItem): NeedsYouRiskMark | null {
  if (item.kind === "proposal") {
    return item.revertable === true ? null : mark("irreversible");
  }
  const ask = item.ask;
  if (!ask) return null;
  if (ask.risk === "high") return mark("high");
  if (ask.reversible === false) return mark("irreversible");
  if (ask.risk === "medium") return mark("medium");
  return null;
}
