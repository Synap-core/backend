/**
 * entryOf / groupEntries — the ONE timeline entry every surface draws (browser,
 * Relay, pod-admin), and how entries are grouped (design 071ad8d2, founder
 * picks of 18 Nov 2026: row density C, by day with a by-Job toggle).
 *
 * `entryOf` turns one {@link ActivityLineEntry} (what `activityLine` returns:
 * a timeline event of a Job or a pull request, a goal-history event, or an
 * Activity row) into one display entry: who, when, the action's words, the
 * mark and the door. It never owns a word: the verb is an existing vocabulary
 * ACTION token (`resolveActivityVerb`), a Job or pull request event reads
 * through `requestStoryLine`, a goal event through `trackHistoryAct`, an
 * Activity row through `activityObjectTitle`, the mark through `markOf`.
 *
 * `groupEntries` folds first, then groups:
 *   FOLD (row density C)  a check that did not fail folds into the row of the
 *     pull request it ran on, by the PR number the check event carries
 *     (`checks.pr`: named by the producer, else read off the head commit a PR
 *     fact named). A red check stands alone. A check that names no pull
 *     request (a devbox job tied to none) stands alone: it is never guessed
 *     into a PR by time order.
 *   GROUP  by day (the viewer's zone, `calendarDayIn`, the Happened rule) or
 *     by Job (first appearance, newest first).
 * Order inside a group is the order given (newest first); nothing is dropped:
 * every entry is in exactly one row, as the row's own entry or as one folded
 * into it.
 *
 * Pure. No words of its own.
 */

import {
  activityActorName,
  activityObjectTitle,
  resolveActivityVerb,
  type ActivityActor,
} from "../activity/index.js";
import { calendarDayIn } from "../activity/heat.js";
import type { LensDoor } from "../lens/rows.js";
import { requestStoryLine } from "../needs-you/request-story.js";
import {
  trackHistoryAct,
  type TrackHistoryContext,
  type TrackHistoryEvent,
} from "../units/track-history.js";
import type { DevTimelineEvent } from "../units/timeline.js";
import type { ActivityLineEntry, ActivityWeight } from "./activity-line.js";
import { markOf, type WorkMark } from "./mark.js";

/** The pull request an entry is about (what a check folds into). */
export interface EntryPullRequest {
  repo: string;
  number: number;
}

export interface WorkEntry {
  /** Stable key: the line entry's. */
  key: string;
  /** The line entry's kind (`pr_merged`, `slot_asked`, `run.run`, `step_moved`…). */
  kind: string;
  at: string;
  /** Present only when the pod recorded it later than `at` ("recorded at"). */
  recordedAt?: string;
  actor: ActivityActor;
  /** Who, as the one short name (`activityActorName`). */
  who: string;
  /** A vocabulary ACTION token; `verb` is its past-mood word. */
  action: string;
  verb: string;
  /** The whole line in words, verb included. */
  text: string;
  mark: WorkMark;
  weight: ActivityWeight;
  failed: boolean;
  /** Where the line opens (a Job, a Request, a step); null = none. */
  door: LensDoor | null;
  /** A pull request or CI run page, when the event names one. */
  url: string | null;
  /** The pull request it is about (a PR fact, or a check that names one). */
  pr: EntryPullRequest | null;
  /** True for a finished-checks entry: the only kind that folds. */
  isCheck: boolean;
  /** The Job it belongs to (group-by-Job key); null = none. */
  jobId: string | null;
}

export interface EntryContext {
  /** The goal a goal-history event belongs to (`trackHistoryAct` needs it). */
  goal?: TrackHistoryContext;
  /** The Job a Job timeline is of: the home of events that carry no session. */
  jobId?: string;
}

/** The vocabulary ACTION token each dev timeline kind wears. */
const DEV_ACTION: Readonly<Record<DevTimelineEvent["kind"], string>> = {
  session_started: "start",
  status_moved: "move",
  pr_opened: "open",
  pr_merged: "merge",
  pr_closed: "close",
  checks_finished: "check",
  decision_asked: "ask",
  decision_answered: "answer", // refined by the decision below
  slot_asked: "ask",
  slot_answered: "answer",
  slot_attested: "attest",
  relay_corrected: "revise",
  question_withdrawn: "withdraw",
  slot_handed_back: "hand_back",
  stage_moved: "move",
  child_started: "spawn",
  runner_seen: "run",
  room_post: "post",
};

function decisionAction(decision: string): string {
  if (decision === "rejected") return "reject";
  if (decision === "reverted") return "revert";
  return "approve";
}

function devDoor(e: DevTimelineEvent): LensDoor | null {
  if (e.refs.proposalId) return { kind: "proposal", id: e.refs.proposalId };
  if (e.kind === "child_started") return { kind: "session", id: e.child.id };
  if (e.refs.sessionId) return { kind: "session", id: e.refs.sessionId };
  return null;
}

function devPullRequest(e: DevTimelineEvent): EntryPullRequest | null {
  switch (e.kind) {
    case "pr_opened":
    case "pr_merged":
    case "pr_closed":
      return { repo: e.pr.repo, number: e.pr.number };
    case "checks_finished":
      return e.checks.pr === null
        ? null
        : { repo: e.checks.repo, number: e.checks.pr };
    default:
      return null;
  }
}

/** One line entry as the one display entry. See the module rule. */
export function entryOf(
  line: ActivityLineEntry,
  ctx: EntryContext = {}
): WorkEntry {
  const base = {
    key: line.key,
    kind: line.kind,
    at: line.at,
    actor: line.actor,
    who: activityActorName(line.actor),
    mark: markOf({ kind: "activity", entry: line }),
    weight: line.weight,
    failed: line.failed,
  };
  if (line.source === "activity") {
    const row = line.row;
    return {
      ...base,
      action: row.action,
      verb: row.verb || resolveActivityVerb(row.action),
      text: `${resolveActivityVerb(row.action)} ${activityObjectTitle(row.action, row.title)}`,
      door: row.proposalId
        ? { kind: "proposal", id: row.proposalId }
        : { kind: row.object.kind, id: row.object.id },
      url: null,
      pr: null,
      isCheck: false,
      jobId: row.session?.id ?? ctx.jobId ?? null,
    };
  }
  const event = line.event;
  if ("stageKey" in event) {
    const goalEvent = event as TrackHistoryEvent;
    const act = trackHistoryAct(
      goalEvent,
      ctx.goal ?? { trackId: "", trackName: "", stages: [] }
    );
    return {
      ...base,
      action: act.action,
      verb: resolveActivityVerb(act.action),
      text: `${resolveActivityVerb(act.action)} ${activityObjectTitle(act.action, act.title)}`,
      door: act.door.id ? act.door : null,
      url: null,
      pr: null,
      isCheck: false,
      jobId: goalEvent.refs.sessionId ?? null,
    };
  }
  const e = event as DevTimelineEvent;
  const action =
    e.kind === "decision_answered"
      ? decisionAction(e.decision)
      : DEV_ACTION[e.kind];
  return {
    ...base,
    ...(e.recordedAt ? { recordedAt: e.recordedAt } : {}),
    action,
    verb: resolveActivityVerb(action),
    text: requestStoryLine(e),
    door: devDoor(e),
    url: e.refs.url ?? null,
    pr: devPullRequest(e),
    isCheck: e.kind === "checks_finished",
    jobId: e.refs.sessionId ?? ctx.jobId ?? null,
  };
}

/** One row of the timeline: an entry and the checks folded into it. */
export interface EntryRow {
  entry: WorkEntry;
  /** Checks that did not fail, folded into this pull request's row. */
  folded: WorkEntry[];
}

export interface EntryGroup {
  /** `day:<YYYY-MM-DD>` or `job:<id>` (`job:none` for entries of no Job). */
  key: string;
  label: { day: string; isToday: boolean } | { jobId: string | null };
  rows: EntryRow[];
}

const prKey = (p: EntryPullRequest) => `${p.repo.toLowerCase()}#${p.number}`;

const timeOf = (at: string) => {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Row density C. A check that did not fail joins the row of its pull request:
 * the newest PR entry (opened, merged, closed) at or before the check, else the
 * oldest one after it. No such entry, or no PR number on the check: it stands
 * alone. A red check always stands alone.
 */
export function foldChecks(entries: readonly WorkEntry[]): EntryRow[] {
  const prEntries = new Map<string, WorkEntry[]>();
  for (const e of entries) {
    if (e.isCheck || !e.pr || !e.kind.startsWith("pr_")) continue;
    const k = prKey(e.pr);
    prEntries.set(k, [...(prEntries.get(k) ?? []), e]);
  }
  const host = (check: WorkEntry): WorkEntry | null => {
    const same = check.pr ? prEntries.get(prKey(check.pr)) : undefined;
    if (!same?.length) return null;
    const t = timeOf(check.at);
    const before = same
      .filter((p) => timeOf(p.at) <= t)
      .sort((a, b) => timeOf(b.at) - timeOf(a.at))[0];
    if (before) return before;
    return [...same].sort((a, b) => timeOf(a.at) - timeOf(b.at))[0] ?? null;
  };
  const folded = new Map<WorkEntry, WorkEntry[]>();
  const rows: EntryRow[] = [];
  const rowOf = new Map<WorkEntry, EntryRow>();
  for (const e of entries) {
    const target = e.isCheck && !e.failed ? host(e) : null;
    if (target) {
      folded.set(target, [...(folded.get(target) ?? []), e]);
      continue;
    }
    const row: EntryRow = { entry: e, folded: [] };
    rowOf.set(e, row);
    rows.push(row);
  }
  for (const [target, checks] of folded) rowOf.get(target)!.folded = checks;
  return rows;
}

/** Fold the checks, then group the rows by day or by Job. */
export function groupEntries(
  entries: readonly WorkEntry[],
  opts: { by: "day" | "job"; timeZone: string; now?: Date }
): EntryGroup[] {
  const rows = foldChecks(entries);
  const groups: EntryGroup[] = [];
  const byKey = new Map<string, EntryGroup>();
  const today = calendarDayIn((opts.now ?? new Date()).getTime(), opts.timeZone);
  for (const row of rows) {
    let key: string;
    let label: EntryGroup["label"];
    if (opts.by === "job") {
      const jobId = row.entry.jobId;
      key = `job:${jobId ?? "none"}`;
      label = { jobId };
    } else {
      const t = Date.parse(row.entry.at);
      // A time the pod sent unreadable is kept, in a group of its own.
      const day = Number.isFinite(t) ? calendarDayIn(t, opts.timeZone) : "unknown";
      key = `day:${day}`;
      label = { day, isToday: day === today };
    }
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}
