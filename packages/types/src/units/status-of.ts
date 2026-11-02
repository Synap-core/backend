/**
 * WHERE DOES IT STAND, ON REQUEST — the parts a `statusOf` answer carries
 * beyond its status (api `services/status/status-read.ts`, one read, three
 * doors: tRPC `lifecycle.statusOf`, Hub `GET /orient?statusOf=&include=`, MCP
 * `synap_orient` `statusOf` + `include`).
 *
 * Every answer about a THING carries its `roles` (the role facets it wears,
 * each with its own status, read under the facet visibility rule) and, when it
 * works at one, its `account` line (the account it works at, with that
 * account's status and roles: the company holds the stage). On `include`:
 *
 *   moves    a thing's step's moves (`StatusOfMove`, in the api);
 *   history  THE timeline (`readTimeline`), kept to status moves, holds and
 *            step entries ({@link isStatusHistoryEvent}), with a session's
 *            stages entered from its stage ledger ({@link StatusOfStageEntered})
 *            and its wait episodes ({@link StatusOfWaitEpisode}, 0386), newest
 *            first, at most {@link STATUS_OF_HISTORY_MAX};
 *   links    a goal's or a session's `serves` edges: what it serves, what
 *            serves it, each end the reader may see;
 *   rollup   a goal's tree, down its `serves` edges: its work per category, its
 *            stuck sessions and its waits per `waitKind`, each node once;
 *   signals  the status signals (`status_signal_raised`) whose episode is still
 *            open: raised in the step it stands in, or on the hold it is under.
 *
 * Pure: types and constants only.
 */

import type { ActivityActor } from "../activity/index.js";
import type { RecordedHold } from "../lifecycle/hold.js";
import type { LifecycleCategory } from "../lifecycle/option.js";
import type { StatusSignal } from "../lifecycle/signal.js";
import type { UnitTone } from "./state.js";
import type { DevTimelineEvent } from "./timeline.js";
import type { TrackHistoryEvent } from "./track-history.js";
import type { WaitEpisode } from "./wait-episode.js";
import type { WaitKind } from "./wait-kind.js";

/** What an answer may carry beyond its status, on request. */
export const STATUS_OF_INCLUDES = [
  "moves",
  "history",
  "links",
  "rollup",
  "signals",
] as const;
export type StatusOfInclude = (typeof STATUS_OF_INCLUDES)[number];

/** History events one answer carries, newest first; more sets `truncated`. */
export const STATUS_OF_HISTORY_MAX = 50;

/**
 * The timeline events that are a STATUS history: a status move (with its hold,
 * a wait episode the move opened), a goal's step entered, its check verdict, a
 * pause and its resume, a session's stage entered (its stage ledger, 0382),
 * a wait episode (`status_wait_episode`, 0386). Sessions, decisions and dev
 * facts stay on the timeline.
 */
export const STATUS_HISTORY_EVENT_KINDS = [
  "status_moved",
  "track_started",
  "step_moved",
  "check_passed",
  "check_held",
  "paused",
  "resumed",
  "status_changed",
  "stage_entered",
  "wait_episode",
] as const;

/**
 * A stage a SESSION entered, read from its stage ledger
 * (`focus_sessions.stage_history`, 0382; the shape of a goal's `step_moved`).
 * Only `include: ["history"]` carries it; the timeline does not.
 */
export interface StatusOfStageEntered {
  /** Stable across reads — a client may key rows by it. */
  id: string;
  kind: "stage_entered";
  /** When it entered the stage (ISO-8601). */
  at: string;
  /** Who moved it, named by the pod: the agent when one drove it. */
  actor: ActivityActor;
  refs: { sessionId: string };
  /** The stage entered. */
  stageKey: string;
  /** The stage left; `null` when the session stood on none. */
  fromStage: string | null;
  /** Which writer recorded it: the stage door, or a re-applied approval. */
  via: "advance" | "approval";
}

/**
 * A stretch of time a thing, goal or session waited on one thing, read from
 * its wait episodes (`status_wait_episode`, 0386, {@link WaitEpisode}):
 * "where the time went". Placed in the history when it OPENED; `closedAt` is
 * null while the wait stands. A role's episode is listed only when the reader
 * may see that role. Only `include: ["history"]` carries it; the timeline
 * does not.
 */
export interface StatusOfWaitEpisode {
  /** The episode's id: stable across reads. */
  id: string;
  kind: "wait_episode";
  /** When the wait opened (= `openedAt`): the history's sort key. */
  at: string;
  waitKind: WaitEpisode["waitKind"];
  /** A hold's `on` when the wait is a pause, else null. */
  on: WaitEpisode["on"];
  /** The coarse waiting-on reason; null for a wait that makes no mark. */
  reason: WaitEpisode["reason"];
  /** What is waited on; null when the pod cannot name it. */
  ref: WaitEpisode["ref"];
  /** ISO. The tick that first found the wait. */
  openedAt: string;
  /** ISO; null while the wait stands. */
  closedAt: string | null;
  /** The role's facet when the wait is on a role's lifecycle, else null. */
  facetId: string | null;
}

/** One entry of `include: ["history"]`. */
export type StatusOfHistoryEvent =
  | DevTimelineEvent
  | TrackHistoryEvent
  | StatusOfStageEntered
  | StatusOfWaitEpisode;

/** A timeline event kept by `include: ["history"]`. */
export function isStatusHistoryEvent(event: StatusOfHistoryEvent): boolean {
  return (STATUS_HISTORY_EVENT_KINDS as readonly string[]).includes(event.kind);
}

/** One role a thing wears, with the role's own status (stored on the facet). */
export interface StatusOfRole {
  facetId: string;
  /** The role's slug (`lead`, `client`). */
  role: string;
  /** The role's display name. */
  roleName: string;
  status: string | null;
  label: string | null;
  category: LifecycleCategory | null;
  tone: UnitTone | null;
  /** Its CURRENT hold, when the role stands in a paused status under one. */
  hold?: RecordedHold;
}

/**
 * The account a thing works at (`works_at`), when the reader may read it: its
 * own status and the roles it wears. A person's stage is read off its account.
 */
export interface StatusOfAccount {
  id: string;
  name: string | null;
  status: string | null;
  label: string | null;
  category: LifecycleCategory | null;
  tone: UnitTone | null;
  roles: StatusOfRole[];
  link: string;
}

/**
 * `include: ["history"]`: THE timeline, kept to its status events, with a
 * session's stage ledger and the subject's wait episodes merged in by time.
 */
export interface StatusOfHistory {
  /**
   * Newest first: a goal's are `TrackHistoryEvent`s, a session's
   * `status_moved` and `stage_entered`, a thing's `status_moved`; each also
   * carries its `wait_episode`s.
   */
  events: StatusOfHistoryEvent[];
  /** Older events exist and are not listed. */
  truncated: boolean;
}

/** One end of a `serves` edge, as the reader may see it. */
export interface StatusOfLinkEnd {
  type: "goal" | "session";
  id: string;
  name: string | null;
  status: string | null;
  category: LifecycleCategory | null;
  tone: UnitTone | null;
  /** The goal criterion a session serves, when the edge names one. */
  criterionKey?: string;
}

/** `include: ["links"]` on a goal or a session: its `serves` edges. */
export interface StatusOfLinks {
  /** What it serves (a goal it is done for). */
  serves: StatusOfLinkEnd[];
  /** What serves it (its sessions and sub-goals). */
  servedBy: StatusOfLinkEnd[];
}

/** Waits counted per wait kind; a kind with none is left out. */
export type WaitKindCounts = Partial<Record<WaitKind, number>>;

/** The numbers a goal's bars are drawn from, for one node of its tree. */
export interface StatusOfRollupCounts {
  /** Its work sessions per category, each session once. */
  byCategory: Partial<Record<LifecycleCategory, number>>;
  /** Sessions the reaper found quiet (`stale`): nobody is moving them. */
  stuck: number;
  /** What its goals and open sessions wait on, per wait kind (the chips). */
  waits: WaitKindCounts;
}

/** A sub-goal (`track --serves--> goal`), rolled up over its own subtree. */
export interface StatusOfRollupChild extends StatusOfRollupCounts {
  id: string;
  name: string | null;
  status: string | null;
  category: LifecycleCategory | null;
  tone: UnitTone | null;
}

/**
 * `include: ["rollup"]` on a goal: the goal and every goal that serves it,
 * down the tree. A node reached twice counts once; a loop of `serves` edges
 * (the door refuses them; an old row may hold one) is walked once and named.
 */
export interface StatusOfRollup extends StatusOfRollupCounts {
  /** Goals in the tree the reader may see, this one included. */
  goals: number;
  /** Work sessions counted, filed in or serving a goal of the tree. */
  sessions: number;
  /** Its direct sub-goals, each over its own subtree. */
  children: StatusOfRollupChild[];
  /** The walk met a loop of `serves` edges and cut it. */
  cycle?: true;
}

/** `include: ["signals"]`: a status signal whose episode is still open. */
export interface StatusOfSignal {
  signal: StatusSignal;
  /** The role whose lifecycle raised it; null for the thing's own. */
  role: string | null;
  raisedAt: string;
}
