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
 *            open: raised in the step it stands in, or on the hold it is under;
 *   work     WHERE ITS WORK STANDS ({@link StatusOfWork}): the sessions and
 *            runs on it, each with its stages, gates, owed asks, hold, stop
 *            reason, next move and, for a run that ended or stopped with
 *            stages left, the person's Continue.
 *
 * `reactions` ({@link StatusOfReaction}) is a typed slot the answer does not
 * fill yet: the rules that fire when it moves.
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

/**
 * What a `statusOf` answer is ABOUT (`StatusOf.type`, api
 * `services/status/status-read.ts`, which types its field by this list). An
 * id the reader cannot see answers `type: "unknown"`, which is not one of
 * these: it names nothing to open.
 */
export const STATUS_OF_ANSWER_TYPES = [
  "entity",
  "goal",
  "session",
  "run",
] as const;
export type StatusOfAnswerType = (typeof STATUS_OF_ANSWER_TYPES)[number];

/** What an answer may carry beyond its status, on request. */
export const STATUS_OF_INCLUDES = [
  "moves",
  "history",
  "links",
  "rollup",
  "signals",
  "work",
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

// ── include: ["work"] — where its work stands ─────────────────────────────

/**
 * Sessions `include: ["work"]` lists on one thing or goal (live first, then
 * newest); more sets `truncated`. A session or a run asked about lists itself.
 */
export const STATUS_OF_WORK_MAX = 5;

/**
 * A part of a work item that could not be read: the continuation packet's
 * own shape (`PacketSection`), never an empty list.
 */
export interface StatusOfWorkUnavailable {
  status: "unavailable";
  reason: string;
}

/** A declared stage, as the room names it (`key`, its `name` else its key). */
export interface StatusOfWorkStageRef {
  key: string;
  name: string;
}

/**
 * Where one declared stage stands: `done` before the stage the run stands
 * on, `current` the stage it stands on (`focus_sessions.current_stage`),
 * `left` after it. A run that stands on no declared stage has every stage
 * `left` (the reading `stagesLeft` gives).
 */
export type StatusOfWorkStagePosition = "done" | "current" | "left";

/** One declared stage of a run, with its newest entry in the stage ledger. */
export interface StatusOfWorkStage extends StatusOfWorkStageRef {
  position: StatusOfWorkStagePosition;
  /**
   * The newest entry of this stage (`session_stage_runs`, the packet's
   * `stageRuns`): who worked it and how that ended. `null` = never entered.
   */
  entry: {
    /** running | waiting_tools | waiting_start | unreached | waiting_child | done | failed | cancelled */
    status: string;
    attempt: number;
    startedAt: string;
    endedAt: string | null;
    /** The agent on it, by name; `null` = Synap AI or unnamed. */
    agentName: string | null;
  } | null;
}

/**
 * A gated stage and where its gate stands (the packet's `gates`, from
 * proposal rows only). Approve / Send back go through the gate's proposal.
 */
export interface StatusOfWorkGate {
  stageKey: string;
  stageName: string;
  kind: "human" | "check" | "awaits";
  state:
    | "not_reached"
    | "pending"
    | "approved"
    | "rejected"
    | "void"
    | "by_criteria";
  /** The latest proposal that decides it, when one exists. */
  proposalId?: string;
  /** A PERSON decided it (never the proposal's own payload). */
  decidedByHuman: boolean;
  decidedAt?: string;
  /** The stage being left when the gate was filed (the proposal's `fromStage`). */
  fromStage?: string | null;
  /** The proposal's own sentence ("Approve stage: Draft for Video 12"). */
  summary?: string | null;
  /**
   * May THIS reader decide it now: the gate waits (`pending`) on a proposal
   * the reader may approve, by the verdict the proposal list and the approve
   * door share (`viewerCanReview`). `false` otherwise: draw no Approve or
   * Send back.
   */
  canReview: boolean;
}

/** A slot the run owes the PERSON (the packet's `userMustDecide.owedSlots`). */
export interface StatusOfWorkAsk {
  label: string;
  /** The slot's kind (`decision`, `document`, …). */
  kind: string;
  /** "Task", "Decision": the kind as the vocabulary names it. */
  noun: string;
  why?: string;
  blockedReason?: string;
  /** When it was handed to the person (ISO). */
  owedSince?: string;
  criterionKey?: string;
  /** How it asks (`confirm`, `choose`, `form`, `act`, `provide`), when it declares an ask. */
  askMode?: string;
  /**
   * The question in the agent's words: a confirm's `prompt`, a form's
   * `title`. Absent when the ask names none (draw `label` then).
   */
  prompt?: string;
}

/** A proposal filed in the session that waits on a decision. */
export interface StatusOfWorkProposal {
  id: string;
  /** Imperative: what approving it does. */
  title: string;
  proposalType: string;
}

/** The session's newest playbook run (`playbook_runs`). */
export interface StatusOfWorkRun {
  id: string;
  status: string;
  label: string;
  category: LifecycleCategory | null;
  /**
   * Why it stopped before it finished, with nobody broken (`RUN_STOP_REASONS`:
   * `budget`, `stages_left`); `null` otherwise.
   */
  stopReason: string | null;
  /** What the run recorded when it ended failed, in the room's words. */
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

/**
 * A run that ended before its last declared stage: where it stopped and what
 * is left. `label` is the person's words ("Stopped at Script").
 */
export interface StatusOfWorkStopped {
  /** The stage it stands on; `null` = before the first stage. */
  at: StatusOfWorkStageRef | null;
  /** The declared stages after it, in order. Never empty. */
  left: StatusOfWorkStageRef[];
  label: string;
}

/**
 * THE CONTINUE DOOR, offered: a run that ended or stopped with stages left
 * and nothing live on it. The SAME session resumes at `at` with a new run
 * turn (tRPC `focusSessions.continueRun`, Hub `POST
 * /focus-sessions/:id/continue`, MCP `synap_continue_session`).
 * A person's move; an agent is refused. Absent = nothing to continue.
 */
export interface StatusOfWorkContinue {
  at: StatusOfWorkStageRef | null;
  left: StatusOfWorkStageRef[];
  /** "Continue at Script". */
  label: string;
  /**
   * May THIS reader continue it now: the Continue door's own check (a person,
   * the session's owner, the key's grant, nothing else live on the record).
   * `false` = draw no Continue button, the door would refuse.
   */
  canAct: boolean;
}

/** THE next move of a work item (the packet's `nextMove`), as the wire carries it. */
export interface StatusOfWorkNextMove {
  /** The packet's `NextMoveKind` (`stopped_early`, `owed_slot`, …). */
  kind: string;
  actor: "user" | "ai" | "none";
  label: string;
  reason: string;
  proposalId?: string;
  sessionId?: string;
  url?: string;
}

/** Who has the session now (the packet's `holder`). */
export interface StatusOfWorkHolder {
  kind: "agent" | "person" | "nobody";
  waitKind: WaitKind | null;
  since: string | null;
  /** The agent on it, by name. */
  agentName: string | null;
  /** Nobody only: the session ended, or no agent is on it. */
  reason?: "ended" | "no_agent";
}

/** One session or run on the subject, and where it stands. */
export interface StatusOfWorkItem {
  sessionId: string;
  name: string | null;
  /** The session's kind (`work`, `run`, …). */
  kind: string;
  status: string;
  label: string;
  category: LifecycleCategory | null;
  tone: UnitTone | null;
  /**
   * How it is on the subject: the session asked about (`self`), the thing
   * is its `subject`, a worker `target`s it, or it is filed in the `goal`.
   */
  on: "self" | "subject" | "target" | "goal";
  playbookId: string | null;
  /** The session's room (`channelId`); `null` = it has none. */
  roomId: string | null;
  /** Its newest playbook run; `null` = it follows no playbook. */
  run: StatusOfWorkRun | null | StatusOfWorkUnavailable;
  /** Its declared stages, in order; `items: []` = a run with no stages. */
  stages:
    | { status: "ok"; items: StatusOfWorkStage[]; current: string | null }
    | StatusOfWorkUnavailable;
  /** Every gated stage, in stage order. */
  gates: { status: "ok"; items: StatusOfWorkGate[] } | StatusOfWorkUnavailable;
  /** What it owes the person, oldest first (`total` exact, items capped). */
  asks:
    | { status: "ok"; total: number; items: StatusOfWorkAsk[] }
    | StatusOfWorkUnavailable;
  /** Proposals filed in it waiting on a decision (`total` exact, capped). */
  proposals:
    | { status: "ok"; total: number; items: StatusOfWorkProposal[] }
    | StatusOfWorkUnavailable;
  /** Its CURRENT hold, when it stands paused under one. */
  hold?: RecordedHold | StatusOfWorkUnavailable;
  holder: StatusOfWorkHolder | StatusOfWorkUnavailable;
  /** Is an agent working on it now (the 5-minute rule). */
  live:
    | { status: "ok"; state: "working" | "idle"; lastActivityAt: string | null }
    | StatusOfWorkUnavailable;
  /** It ended before its last stage; `null` otherwise. */
  stopped: StatusOfWorkStopped | null;
  /** The last close or verification it recorded; `null` = none. */
  lastCompletion: {
    closedAt: string | null;
    summary?: string;
    unfinishedOutputs?: number;
  } | null;
  nextMove: StatusOfWorkNextMove;
  /** Offered only when the door would run ({@link StatusOfWorkContinue}). */
  continue?: StatusOfWorkContinue;
  link: string;
}

/** `include: ["work"]`: the work on a thing, goal, session or run. */
export interface StatusOfWork {
  items: StatusOfWorkItem[];
  /** More sessions are on it than listed ({@link STATUS_OF_WORK_MAX}). */
  truncated: boolean;
}

// ── reactions (typed slot; not filled yet) ────────────────────────────────

/**
 * A RULE that fires when the subject moves (WHEN a subject reaches a status
 * or category → VIA one link → DO one effect through the target's own door).
 * The person sees the word "Rules" (decision D8).
 * RESERVED: no read fills it yet.
 */
export interface StatusOfReaction {
  ruleId: string;
  /** The rule's name, as the Rules list shows it. */
  name: string;
  /** Who declared it: a pod default, a relation, a playbook stage, a person. */
  source: "default" | "relation" | "stage" | "user";
  /** The status or category that fires it. */
  when: { to?: string; category?: LifecycleCategory };
  /** The link it follows to its target. */
  via: string | null;
  /** What it does there, in words. */
  does: string;
  paused: boolean;
}
