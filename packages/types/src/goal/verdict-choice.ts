/**
 * The Declare done bar's CHOICE — one model the desk's `VerdictBar` (web) and
 * the phone's twin (relay) both render, so neither holds a rule:
 *
 *   - which side opens (close, or drop when the person came from a Drop door
 *     or may only drop);
 *   - NO verdict is picked for the person (R9, review UX-2): the confirm stays
 *     disabled, with the reason shown, until they pick one;
 *   - it is DERIVED on every read: a verdict the person picked that the pod
 *     would no longer accept (a re-read after an Accept) is dropped, never
 *     kept as an invisible choice behind a grey confirm;
 *   - Impossible asks the closer's words; Replaced asks WHICH goal replaces
 *     it (a goal picked from the pod-wide list, never free text);
 *   - the confirm's words ("Close as met", "Drop as impossible", "Retire") and
 *     the bar's copy.
 *
 * The verdicts themselves, which are allowed and why one is not, are
 * `goalVerdicts` (`./model`, over the pod's `trackVerdictsFor` +
 * `checkTrackClose`). PURE: no React — each host keeps only `ending`,
 * `picked`, `reason` and `replacementId` as state and calls this each render.
 */
import {
  isTrackClosed,
  type TrackStatus,
  type TrackVerdict,
} from "../units/index.js";
import {
  nounInSentence,
  resolveActionLabel,
  resolveObjectNoun,
} from "../vocabulary/index.js";
import { goalTitle } from "./collection.js";
import type { GoalLike, GoalVerdictChoice, GoalVerdicts } from "./model.js";

export type VerdictEnding = "close" | "drop";

/** The bar's own words — copy, not stored values. One set for desk and phone. */
export const VERDICT_BAR_COPY = {
  closeLegend: "Your verdict",
  dropLegend: "Why drop it?",
  dropInstead: "Drop it instead",
  closeInstead: "Close it instead",
  notYet: "Not yet",
  tryAgain: "Try again",
  impossibleAsk: "What makes it impossible?",
  replacedAsk: "Which goal replaces it?",
  /** Why the confirm is disabled. */
  pickOne: "Pick how it ended.",
  sayWhy: "Say what makes it impossible.",
  pickReplacement: "Pick the goal that replaces it.",
} as const;

/** What the bar asks beside the chosen verdict, when it needs more than the pick. */
export type VerdictReasonAsk =
  | { kind: "text"; label: string }
  /** Replaced: a goal picked from `replacementChoices`. */
  | { kind: "goal"; label: string };

/** A goal that may be named as the replacement. */
export interface ReplacementChoice {
  id: string;
  label: string;
}

/** What the host sends (`useGoalActions().setStatus`). */
export interface VerdictDeclaration {
  to: TrackStatus;
  verdict: TrackVerdict;
  /** The closer's words — impossible's reason, or the replacing goal's name. */
  verdictReason?: string;
  /** Replaced: the goal that replaces it. */
  replacedById?: string;
}

export interface VerdictChoiceInput {
  verdicts: GoalVerdicts;
  /** The side the person switched to; `null` = not switched (the opening side). */
  ending: VerdictEnding | null;
  /** The side to open on — `drop` from a Drop door. Falls back to the side the viewer may use. */
  initialEnding?: VerdictEnding;
  /** What the person picked — `null` until they do. */
  picked: TrackVerdict | null;
  /** The words typed for a verdict that needs them. */
  reason: string;
  /** Replaced: the goal the person picked. */
  replacementId: string | null;
  /** The goals that may replace this one (`replacementChoices`). */
  replacements?: readonly ReplacementChoice[];
}

export interface VerdictChoiceView {
  /** Nothing the viewer may choose ⇒ no bar (the host shows `verdicts.refusal` as a mark). */
  shown: boolean;
  ending: VerdictEnding;
  /** The radio group's legend. */
  legend: string;
  /** The verdicts on this side, each with why it cannot be chosen now. */
  choices: readonly GoalVerdictChoice[];
  /** The person's pick, when the pod would still accept it. Never a default. */
  choice: GoalVerdictChoice | null;
  /** Switch sides: its words, `null` when the viewer may only use one side. */
  switchLabel: string | null;
  ask: VerdictReasonAsk | null;
  /** The confirm's words — "Close as met", "Drop as impossible", "Retire". */
  confirmLabel: string;
  /** Why the confirm is disabled — `null` when it can be pressed. Shown beside it. */
  blocked: string | null;
  /** What to send — `null` while `blocked`. */
  declaration: VerdictDeclaration | null;
}

/** The confirm's words: "Close as met", "Drop as impossible", "Retire"; a bare "Close"/"Drop" before a pick. */
export function verdictConfirmLabel(
  choice: GoalVerdictChoice | null,
  ending: VerdictEnding
): string {
  if (!choice) return resolveActionLabel(ending, "imperative");
  if (choice.verdict === "retired")
    return resolveActionLabel("retire", "imperative");
  return `${resolveActionLabel(choice.ending, "imperative")} as ${nounInSentence(choice.label)}`;
}

/** The side the bar opens on. */
export function openingVerdictEnding(
  verdicts: GoalVerdicts,
  initialEnding?: VerdictEnding
): VerdictEnding {
  return (initialEnding === "drop" && verdicts.mayDrop) || !verdicts.mayClose
    ? "drop"
    : "close";
}

/** The bar for one render. */
export function verdictChoice(input: VerdictChoiceInput): VerdictChoiceView {
  const { verdicts } = input;
  const ending =
    input.ending ?? openingVerdictEnding(verdicts, input.initialEnding);
  const choices = ending === "close" ? verdicts.close : verdicts.drop;
  const choice = input.picked
    ? (choices.find(
        (c) => c.verdict === input.picked && c.unavailable === null
      ) ?? null)
    : null;
  const ask: VerdictReasonAsk | null = !choice?.needsReason
    ? null
    : choice.verdict === "replaced"
      ? { kind: "goal", label: VERDICT_BAR_COPY.replacedAsk }
      : { kind: "text", label: VERDICT_BAR_COPY.impossibleAsk };
  const replacement =
    ask?.kind === "goal"
      ? ((input.replacements ?? []).find((r) => r.id === input.replacementId) ??
        null)
      : null;
  const words = input.reason.trim();
  const blocked = !choice
    ? VERDICT_BAR_COPY.pickOne
    : ask?.kind === "text" && !words
      ? VERDICT_BAR_COPY.sayWhy
      : ask?.kind === "goal" && !replacement
        ? VERDICT_BAR_COPY.pickReplacement
        : null;
  const declaration: VerdictDeclaration | null =
    choice && !blocked
      ? {
          to: choice.to,
          verdict: choice.verdict,
          // TODO(goals-backend): the pod keeps no replaced-by link on setStatus yet;
          // the replacing goal's NAME rides `verdictReason` (what the header shows),
          // its id rides `replacedById` for the host once the door takes it.
          ...(replacement
            ? { verdictReason: replacement.label, replacedById: replacement.id }
            : words
              ? { verdictReason: words }
              : {}),
        }
      : null;
  return {
    shown: verdicts.close.length > 0 || verdicts.drop.length > 0,
    ending,
    legend:
      ending === "close"
        ? VERDICT_BAR_COPY.closeLegend
        : VERDICT_BAR_COPY.dropLegend,
    choices,
    choice,
    switchLabel:
      verdicts.mayClose && verdicts.mayDrop
        ? ending === "close"
          ? VERDICT_BAR_COPY.dropInstead
          : VERDICT_BAR_COPY.closeInstead
        : null,
    ask,
    confirmLabel: verdictConfirmLabel(choice, ending),
    blocked,
    declaration,
  };
}

/**
 * The goals that may replace `goal`: every other goal still open, newest
 * first, named as the goals list names them. Read from the pod-wide list
 * (`tracks.list` with no project).
 */
export function replacementChoices(
  goal: Pick<GoalLike, "id">,
  goals: ReadonlyArray<
    Pick<GoalLike, "id" | "name" | "status"> & { updatedAt?: string | null }
  >
): ReplacementChoice[] {
  const at = (iso: string | null | undefined) => {
    const t = iso ? new Date(iso).getTime() : Number.NaN;
    return Number.isNaN(t) ? 0 : t;
  };
  return goals
    .filter((g) => g.id !== goal.id && !isTrackClosed(g))
    .sort((a, b) => at(b.updatedAt) - at(a.updatedAt))
    .map((g) => ({ id: g.id, label: goalTitle(g) }));
}

/** The acts on a goal a failed write can name. */
export type GoalWriteAct =
  | "close"
  | "drop"
  | "retire"
  | "reopen"
  | "accept"
  | "send_back"
  | "move"
  | "pause"
  | "resume"
  | "start"
  | "edit"
  | "add"
  | "remove"
  | "acknowledge"
  | "counter"
  | "decline"
  | "report_impossible"
  | "pin"
  | "unpin"
  /** "Keep it running" (R6, `startOperationFrom`) — "Couldn't keep running the goal." */
  | "keep_running"
  /** The owner's answer to a counter-offer (`take_offer` / `keep_ask`). */
  | "take_offer"
  | "keep_ask";

/**
 * A write that did not land, in a plain sentence — never the pod's raw
 * message (a machine token, an id, an agent's wording). "Couldn't close the
 * goal. Nothing changed; try again." The host keeps the retry beside it.
 */
export function goalWriteFailure(act: GoalWriteAct): string {
  // Both answers to a counter-offer are one act for the reader: answering it.
  if (act === "take_offer" || act === "keep_ask")
    return "Couldn't answer the counter-offer. Nothing changed; try again.";
  const verb = resolveActionLabel(act, "imperative").toLowerCase();
  return `Couldn't ${verb} the ${nounInSentence(resolveObjectNoun("track"))}. Nothing changed; try again.`;
}
