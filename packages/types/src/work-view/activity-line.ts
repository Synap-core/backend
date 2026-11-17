/**
 * activityLine — ONE ordered Activity line for a goal, a job or a pull request,
 * newest first, at one of three densities (plan 5207fbb6, point of view
 * 3e47abde §3, Q4):
 *
 *   summary     the open ask pinned at Now, at most
 *               {@link ACTIVITY_SUMMARY_MILESTONES} milestones, and a recap
 *               of what was left out;
 *   milestones  the open ask and every milestone;
 *   trace       everything.
 *
 * Two sources, one line: the timeline (`TimelineWire`, Hub `GET /timeline`,
 * tRPC `focusSessions.timeline`) and the Activity rows of the same subject
 * (`ActivityRow`, `activity.list`). A decision both report (same proposal) is
 * drawn once, from the timeline.
 *
 * WEIGHT, the one rule a surface reads:
 *   ask        an ask still open (asked, not answered, attested or withdrawn);
 *   milestone  a move of the work: started, a status move, a step, a PR
 *              opened / merged / closed, a decision, an answer, a job closed,
 *              a check held or passed, something an agent made or changed;
 *   trace      a machine's receipt: an automation or playbook run, a worker
 *              fire, a tool call, a CI or devbox run.
 * A trace that FAILED, or a run that decided something (its outcome is not
 * plain success: rejected, reverted, waiting on you), is a milestone.
 *
 * Pure. No words: a surface names an entry through the vocabulary door.
 */

import type { ActivityActor, ActivityRow } from "../activity/index.js";
import type { LifecycleCategory } from "../lifecycle/option.js";
import {
  isTrackHistoryFailure,
  type TrackHistoryEvent,
} from "../units/track-history.js";
import type { DevTimelineEvent, TimelineWire } from "../units/timeline.js";

export const ACTIVITY_DENSITIES = ["summary", "milestones", "trace"] as const;
export type ActivityDensity = (typeof ACTIVITY_DENSITIES)[number];

/** How many milestones Summary shows under the pinned ask. */
export const ACTIVITY_SUMMARY_MILESTONES = 5;

export type ActivityWeight = "ask" | "milestone" | "trace";

export type ActivityLineEntry =
  | {
      key: string;
      source: "timeline";
      at: string;
      weight: ActivityWeight;
      failed: boolean;
      actor: ActivityActor;
      /** The event's kind (`slot_asked`, `pr_merged`, `step_moved`, …). */
      kind: string;
      /** A status move's category: what `markOf` paints it with. */
      category: LifecycleCategory | null;
      event: DevTimelineEvent | TrackHistoryEvent;
    }
  | {
      key: string;
      source: "activity";
      at: string;
      weight: ActivityWeight;
      failed: boolean;
      actor: ActivityActor;
      /** `<source>.<action>` (`run.run`, `proposal.create`, …). */
      kind: string;
      category: null;
      row: ActivityRow;
    };

export interface ActivityLine {
  /** The newest ask still open, pinned at Now; null when nothing is asked. */
  now: ActivityLineEntry | null;
  /** The line at this density, newest first (the pinned ask not repeated). */
  entries: ActivityLineEntry[];
  /** What this density left out, by weight: the recap ("and 12 more"). */
  hidden: Record<ActivityWeight, number>;
  /** The timeline hit a scan cap: older events exist and are not listed. */
  truncated: boolean;
  /**
   * Reads that FAILED: `activity` when the Activity rows could not be read
   * (passed as `null`). Their entries are missing, not absent: a surface says
   * so, never draws the timeline alone as the whole story.
   */
  unavailable: Array<"activity">;
}

type AnyEvent = DevTimelineEvent | TrackHistoryEvent;

/** An ask event's slot (dev timeline) or proposal (both): what answers it. */
function askAddress(e: AnyEvent): string | null {
  if (e.kind === "slot_asked") return `slot:${e.slot}`;
  if (e.kind === "decision_asked") {
    return e.refs.proposalId ? `proposal:${e.refs.proposalId}` : null;
  }
  return null;
}

/** The ask an event closes, if any. */
function closesAddress(e: AnyEvent): string | null {
  switch (e.kind) {
    case "slot_answered":
    case "slot_attested":
      return `slot:${e.slot}`;
    case "question_withdrawn":
      return e.slot ? `slot:${e.slot}` : null;
    case "decision_answered":
      return e.refs.proposalId ? `proposal:${e.refs.proposalId}` : null;
    default:
      return null;
  }
}

/** The ask an event gives back to the person ("Not what I said"), if any. */
function reopensAddress(e: AnyEvent): string | null {
  return e.kind === "relay_corrected" && e.slot ? `slot:${e.slot}` : null;
}

function eventFailed(e: AnyEvent): boolean {
  if ("stageKey" in e) return isTrackHistoryFailure(e);
  switch (e.kind) {
    case "status_moved":
      return e.category === "lost" || e.to === "failed";
    case "checks_finished":
      return e.checks.result === "failed";
    case "decision_answered":
      return e.decision === "approval_failed";
    default:
      return false;
  }
}

function eventWeight(e: AnyEvent, failed: boolean): ActivityWeight {
  if (e.kind === "checks_finished") return failed ? "milestone" : "trace";
  return "milestone";
}

/** A run, a worker fire or a tool receipt: a machine's act. */
function isMachineRow(row: ActivityRow): boolean {
  return row.source === "run" || row.actor.kind === "system";
}

function rowWeight(row: ActivityRow, failed: boolean): ActivityWeight {
  if (!isMachineRow(row)) return "milestone";
  if (failed) return "milestone";
  // A run that decided something: not plain success, not still running.
  return row.outcome === "succeeded" || row.outcome === "running"
    ? "trace"
    : "milestone";
}

function timeOf(at: string): number {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
}

/**
 * One Activity line from a subject's timeline and Activity rows. See the module
 * rule. `activity` is the subject's rows (`[]` when it has none), or `null`
 * when their read FAILED: the line is then drawn from the timeline and says
 * `unavailable: ["activity"]`. Equal times keep the pods' order: the
 * timeline's wire order, then the Activity rows' page order.
 */
export function activityLine(
  timeline: Pick<TimelineWire, "events" | "truncated">,
  activity: readonly ActivityRow[] | null,
  density: ActivityDensity
): ActivityLine {
  const events = timeline.events as readonly AnyEvent[];
  // The wire is newest first; replay it oldest first (ties keep the pod's
  // order): an ask is open unless a later event closes it, and open again
  // when a later correction gives it back.
  const openAsk = new Set<string>();
  const byTime = [...events].reverse();
  for (const e of byTime) {
    const closes = closesAddress(e);
    if (closes) openAsk.delete(closes);
    const opens = askAddress(e) ?? reopensAddress(e);
    if (opens) openAsk.add(opens);
  }
  // The open ask is the LATEST ask event of each open address.
  const latestAsk = new Map<string, string>();
  for (const e of byTime) {
    const a = askAddress(e);
    if (a && openAsk.has(a)) latestAsk.set(a, e.id);
  }
  const openEventIds = new Set(latestAsk.values());

  const decided = new Set<string>();
  const entries: ActivityLineEntry[] = [];
  /** Wire position: the tie-break on equal times. */
  const order = new Map<ActivityLineEntry, number>();
  for (const e of events) {
    const failed = eventFailed(e);
    const ask = askAddress(e);
    // An ask that was answered is history: a milestone. A repeat of an open
    // ask (asked again) is drawn once, at its latest.
    if (ask && openAsk.has(ask) && !openEventIds.has(e.id)) continue;
    if (e.refs.proposalId) decided.add(e.refs.proposalId);
    entries.push({
      key: `timeline:${e.id}`,
      source: "timeline",
      at: e.at,
      weight: openEventIds.has(e.id) ? "ask" : eventWeight(e, failed),
      failed,
      actor: e.actor,
      kind: e.kind,
      category: e.kind === "status_moved" ? e.category : null,
      event: e,
    });
    order.set(entries[entries.length - 1]!, order.size);
  }
  for (const row of activity ?? []) {
    if (row.proposalId && decided.has(row.proposalId)) continue;
    const failed = row.outcome === "failed";
    entries.push({
      key: `activity:${row.id}`,
      source: "activity",
      at: row.occurredAt,
      weight: rowWeight(row, failed),
      failed,
      actor: row.actor,
      kind: `${row.source}.${row.action}`,
      category: null,
      row,
    });
    order.set(entries[entries.length - 1]!, order.size);
  }
  entries.sort(
    (a, b) => timeOf(b.at) - timeOf(a.at) || order.get(a)! - order.get(b)!
  );

  const now = entries.find((e) => e.weight === "ask") ?? null;
  const rest = entries.filter((e) => e !== now);
  const hidden: Record<ActivityWeight, number> = {
    ask: 0,
    milestone: 0,
    trace: 0,
  };
  let shown: ActivityLineEntry[];
  if (density === "trace") {
    shown = rest;
  } else {
    const kept = rest.filter((e) => e.weight !== "trace");
    shown =
      density === "summary"
        ? kept
            .filter((e) => e.weight === "milestone")
            .slice(0, ACTIVITY_SUMMARY_MILESTONES)
        : kept;
  }
  const shownSet = new Set(shown);
  for (const e of rest) if (!shownSet.has(e)) hidden[e.weight] += 1;
  return {
    now,
    entries: shown,
    hidden,
    truncated: timeline.truncated,
    unavailable: activity === null ? ["activity"] : [],
  };
}
