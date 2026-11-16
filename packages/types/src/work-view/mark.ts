/**
 * markOf — the ONE mark (tone + glyph + state) a Work-view request or Activity
 * entry wears. It never names a colour of its own; every answer comes from a
 * door that already exists:
 *
 *   a request            `resolveWaitKindState` / `resolveUnitState`;
 *   an Activity row      `resolveActivityOutcomeView` (its own outcome: a
 *                        rejected or reverted act is muted, never "done");
 *   a decision answered  the same, through `activityOutcomeForProposal`;
 *   a job closed         the same, through `activityOutcomeForSession`;
 *   a status move        `lifecycleCategoryMark` (`LIFECYCLE_CATEGORY_TONE`:
 *                        waiting / paused is `warning`);
 *   an open ask          `resolveUnitState({ owedFromYou })`;
 *   anything else        "it happened": `resolveUnitState({ terminal })`.
 *
 * No second tone list (`one-tone-list.tripwire.test.ts`). A job, a run or a
 * wait on its own is marked by the units door directly (`resolveUnitState`,
 * `resolveRunUnitState`, `resolveWaitKindState`): no pass-through here.
 */

import {
  activityOutcomeForProposal,
  activityOutcomeForSession,
  resolveActivityOutcomeView,
  type ActivityOutcome,
} from "../activity/index.js";
import { lifecycleCategoryMark, type GoalGlyph } from "../goal/marks.js";
import {
  resolveUnitState,
  resolveWaitKindState,
  type UnitStateView,
  type UnitTone,
} from "../units/state.js";
import type { ActivityLineEntry } from "./activity-line.js";
import type { RequestSignal, WorkRequest } from "./requests.js";

export interface WorkMark {
  /** The machine token the mark stands for (a unit state, an outcome, a status): never shown. */
  state: string;
  tone: UnitTone;
  glyph: GoalGlyph;
}

export type MarkSubject =
  | {
      kind: "request";
      request: WorkRequest<RequestSignal & { waitKind?: string | null }>;
    }
  | { kind: "activity"; entry: ActivityLineEntry };

function pick(v: UnitStateView): WorkMark {
  return { state: v.state, tone: v.tone, glyph: v.glyph };
}

function outcome(o: ActivityOutcome): WorkMark {
  const v = resolveActivityOutcomeView(o);
  return { state: v.outcome, tone: v.tone, glyph: v.glyph };
}

/** The mark of one Work-view thing. See the module rule. */
export function markOf(x: MarkSubject): WorkMark {
  if (x.kind === "request") {
    const { request } = x;
    if (request.reason === "failure") {
      return pick(resolveUnitState({ failed: true }));
    }
    const waitKind = request.lead.waitKind;
    if (waitKind) return pick(resolveWaitKindState(waitKind));
    return pick(
      resolveUnitState(
        request.bucket === "decision" || request.bucket === "routine"
          ? { pendingDecisions: request.items.length }
          : { owedFromYou: request.items.length }
      )
    );
  }
  const { entry } = x;
  if (entry.source === "activity") return outcome(entry.row.outcome);
  if (entry.weight === "ask") return pick(resolveUnitState({ owedFromYou: 1 }));
  const e = entry.event;
  if (e.kind === "decision_answered") {
    return outcome(activityOutcomeForProposal(e.decision));
  }
  if (e.kind === "session_closed") {
    return outcome(
      e.verdict === "failing"
        ? "failed"
        : activityOutcomeForSession(e.sessionStatus)
    );
  }
  if (entry.failed) return pick(resolveUnitState({ failed: true }));
  if (e.kind === "status_moved") {
    return { state: e.to, ...lifecycleCategoryMark(e.category) };
  }
  return pick(resolveUnitState({ terminal: true }));
}
