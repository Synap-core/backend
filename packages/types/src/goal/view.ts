/**
 * The goal VIEW — everything a goal page or a Declare done page shows of one
 * goal for one viewer, built ONCE (`goalViewFor`). The desk memoises it
 * (`useGoalView`, `@synap-core/hooks/goal`), the phone calls it from its own
 * read; neither re-assembles the parts (surfaces F5).
 *
 * Decided here, once:
 *   - "Done when" leads with the END STATE only. The purpose stays the
 *     header's line under the title; it never stands in for an unsaid end
 *     state (the phone's Declare done did `endState ?? purpose`).
 *   - A lasting goal (no criteria) INVITES criteria in one sentence when the
 *     viewer may edit it (the setDirection door), else EXPLAINs.
 *   - Drop conditions: the field's label ("Drop it if") + each condition as written; none ⇒ OMIT.
 *   - The Declare done door's words: "Retire" for an operation (R6), else
 *     "Declare done"; offered when the viewer may close or drop.
 *   - An operation reads per WEEK (R6): "This week · Met" from the pod's
 *     `periodReading` — never "done", never a percent.
 *   - A goal closed as MET offers "Keep it running" to a person: the pod's
 *     `tracks.startOperationFrom` (its own rule: closed + met only).
 *
 * PURE: no React.
 */
import {
  DECLARE_DONE_LABEL,
  GOAL_FIELD_LABELS,
  resolveActionLabel,
  resolveOperationPeriodMarkLabel,
} from "../vocabulary/index.js";
import {
  goalCriteriaCount,
  goalCriterionRows,
  goalHeader,
  goalParticipantRows,
  goalStatusMoves,
  goalVerdicts,
  viewerMayStaff,
  type GoalCriteriaCount,
  type GoalCriterionRow,
  type GoalHeaderView,
  type GoalLike,
  type GoalNameOf,
  type GoalParticipantRow,
  type GoalStatusMove,
  type GoalVerdicts,
  type GoalViewer,
} from "./model.js";
import { periodMark, type GoalMarkView } from "./marks.js";

/** Copy, not stored values — one set for desk and phone. The two goal words are the vocabulary's. */
export const GOAL_VIEW_COPY = {
  declareDone: DECLARE_DONE_LABEL,
  dropIf: GOAL_FIELD_LABELS.dropConditions,
  /** A lasting goal the viewer may edit: one sentence, the act beside it. */
  lastingInvite: "No criteria yet: this goal stays open as long as it matters.",
  addCriteria: "Add criteria",
  /** A lasting goal the viewer may not edit. */
  lastingTitle: "No criteria",
  lastingExplain:
    "This goal stays open as long as it matters; its owner can add criteria.",
  /** A criterion row's words (the web row and its relay twin). */
  aboutMethod: "About the method",
  optional: "Optional",
  /** Send back asks in the row what should change — the pod requires the note. */
  sendBackAsk: "What should change?",
  /** Accept an outside / certified criterion nobody claimed, naming the source. */
  acceptWithSource: "Accept with source…",
  sourceAsk: "Who or what decided it?",
  /** An operation's period (R6): the pod reads it Monday to Monday. */
  period: "This week",
} as const;

/** How an operation's period reads (`OPERATION_PERIOD_MARKS`). */
export type GoalPeriodMark = "met" | "not_met" | "unmeasured";

/** An operation's reading for this week — `null` for other kinds, or a pod that sent none. */
export interface GoalPeriodView {
  /** "This week". */
  label: string;
  mark: GoalPeriodMark;
  /** "Met" / "Not met" / "Not checked" — the vocabulary's. */
  markLabel: string;
  /** The mark to draw (tone, glyph, words) — `periodMark`, the criterion marks' tones. */
  markView: GoalMarkView;
  from: string;
  to: string;
}

const PERIOD_MARKS: readonly string[] = ["met", "not_met", "unmeasured"];

export function goalPeriod(
  goal: Pick<GoalLike, "workKind" | "periodReading">
): GoalPeriodView | null {
  const r = goal.periodReading;
  if (goal.workKind !== "operation" || !r) return null;
  // An unknown mark (a newer pod) reads as not checked — never as met.
  const mark = (
    PERIOD_MARKS.includes(r.mark) ? r.mark : "unmeasured"
  ) as GoalPeriodMark;
  return {
    label: GOAL_VIEW_COPY.period,
    mark,
    markLabel: resolveOperationPeriodMarkLabel(mark),
    markView: periodMark(mark),
    from: r.from,
    to: r.to,
  };
}

/** The goal's drop conditions — `null` when it names none (OMIT: nothing to fill here). */
export interface GoalDropConditionsView {
  /** "Drop it if" (the field's label). */
  label: string;
  items: { key: string; text: string }[];
}

export function goalDropConditions(
  goal: Pick<GoalLike, "dropConditions">
): GoalDropConditionsView | null {
  const items = goal.dropConditions
    .map((text, i) => ({ key: `drop:${i}`, text: text.trim() }))
    .filter((c) => c.text.length > 0);
  return items.length > 0 ? { label: GOAL_VIEW_COPY.dropIf, items } : null;
}

/** The empty "Done when" answer for a lasting goal — `null` when it has criteria. */
export type GoalLastingView =
  | { tone: "invite"; title: string; action: string }
  | { tone: "explain"; title: string; description: string };

/** What leads "Done when", above its rows (`GoalView.criteria`) and count. */
export interface GoalDoneWhenView {
  /** What done looks like — `null` when unsaid (never the purpose in its place). */
  endState: string | null;
  lasting: GoalLastingView | null;
}

/**
 * "Keep it running" — offered to a person on a goal closed as MET that is not
 * itself an operation (the pod refuses any other source). A repeat answers
 * the live operation already started (`exists`): the host lands on it.
 */
export function goalMayKeepRunning(
  goal: Pick<GoalLike, "status" | "verdict" | "workKind">,
  viewer: GoalViewer
): boolean {
  return (
    viewer.kind === "person" &&
    !!viewer.userId &&
    goal.status === "completed" &&
    goal.verdict === "met" &&
    goal.workKind !== "operation"
  );
}

/** The door to Declare done — `null` when the viewer may neither close nor drop. */
export interface GoalDeclareDoor {
  label: string;
  /** The judge has a verdict waiting (in review): the page's primary. */
  primary: boolean;
}

export interface GoalView {
  header: GoalHeaderView;
  doneWhen: GoalDoneWhenView;
  /** `null` = participants not read — say so, never an empty "Who's on it". */
  participants: GoalParticipantRow[] | null;
  dropConditions: GoalDropConditionsView | null;
  moves: GoalStatusMove[];
  verdicts: GoalVerdicts;
  declare: GoalDeclareDoor | null;
  /** The viewer may change the goal (end state, criteria, people): its owner or judge, a person. */
  mayEdit: boolean;
  /** The "Done when" rows, in the goal's declared order. */
  criteria: GoalCriterionRow[];
  /** "3 of 5 met · 1 claimed" — never a percent. */
  count: GoalCriteriaCount;
  /** An operation's week (R6); `null` otherwise. */
  period: GoalPeriodView | null;
  /** "Keep it running" (R6) — `null` when not offered (see `goalMayKeepRunning`). */
  keepRunning: { label: string } | null;
}

export interface GoalViewOptions {
  viewer: GoalViewer;
  /** A fallback name for a participant the read did not name — see `GoalNameOf`. */
  nameOf?: GoalNameOf;
  now?: Date;
}

/** The whole view of one goal for one viewer. */
export function goalViewFor(
  goal: GoalLike,
  { viewer, nameOf, now }: GoalViewOptions
): GoalView {
  const header = goalHeader(goal, nameOf);
  const rows = goalCriterionRows(goal, viewer);
  const count = goalCriteriaCount(goal);
  const verdicts = goalVerdicts(goal, viewer);
  const mayEdit = viewerMayStaff(goal, viewer);
  const lasting: GoalLastingView | null =
    goal.criteria.length > 0
      ? null
      : mayEdit
        ? {
            tone: "invite",
            title: GOAL_VIEW_COPY.lastingInvite,
            action: GOAL_VIEW_COPY.addCriteria,
          }
        : {
            tone: "explain",
            title: GOAL_VIEW_COPY.lastingTitle,
            description: GOAL_VIEW_COPY.lastingExplain,
          };
  const declare: GoalDeclareDoor | null =
    verdicts.mayClose || verdicts.mayDrop
      ? {
          label:
            goal.workKind === "operation"
              ? resolveActionLabel("retire", "imperative")
              : GOAL_VIEW_COPY.declareDone,
          primary: verdicts.mayClose && goal.inReview === true,
        }
      : null;
  return {
    header,
    doneWhen: { endState: header.endState, lasting },
    participants: goalParticipantRows(goal, viewer, nameOf, now),
    dropConditions: goalDropConditions(goal),
    moves: goalStatusMoves(goal, viewer),
    verdicts,
    declare,
    mayEdit,
    criteria: rows,
    count,
    period: goalPeriod(goal),
    // The pod's verb for `startOperationFrom` ("Keep it running").
    keepRunning: goalMayKeepRunning(goal, viewer)
      ? { label: resolveActionLabel("track.keep_running", "imperative") }
      : null,
  };
}
