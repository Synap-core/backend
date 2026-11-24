/**
 * THE REQUEST CONTEXT — what `signals.needsYou({ include: ["context"] })`
 * adds to a page of needs-you rows, so a surface can tell each request's
 * story (`requestStory`) without a read per row (founder decision 1 A, plan
 * d717d6ac §5). The pod reads each part ONCE for the whole page, from its one
 * owner:
 *
 *   timeline   the newest items of each row's session (`readSessionTimelines`,
 *              the timeline door's own projection, slot asks included);
 *   aiCanDo    what the agent can do meanwhile (the continuation packet's
 *              `aiCanDo` rule, over the same session rows);
 *   waiting    the open sessions that wait on it (`session --blocked_by-->`);
 *   proposalWaits  for a proposal row, whether an agent waits on it and why
 *              (`resolveProposalWaits`);
 *   subject    the object the request is ABOUT, so the card can show and
 *              open it: an owed slot's `ref` (`slotRef`), a proposal's
 *              target. Resolved under the reader's own read floor (the one
 *              `isOutputRefVisible` applies), batched per kind; a ref the
 *              reader cannot read is ABSENT, exactly like no ref (its title
 *              is never served).
 *
 * What the row itself carries (`unblocks`, `blocks` with its status now and
 * next, `by`, `askCause`, the session's title) is NOT repeated here.
 *
 * A part whose read FAILED is `{ status: "unreadable" }` for every row it
 * would have answered: never an empty list, never a quiet absence.
 *
 * Pure types and constants (the pod, pod admin, the browser and relay read
 * the same contract).
 */

import type { MediaRef } from "../presentation/index.js";
import type { ProposalWaits } from "../proposals/fate.js";
import type { DevTimelineEvent } from "../units/timeline.js";

/** What `signals.needsYou` may be asked to add (`include`). */
export const NEEDS_YOU_INCLUDE = ["context"] as const;
export type NeedsYouInclude = (typeof NEEDS_YOU_INCLUDE)[number];

/** Timeline items per session when the caller names none. */
export const REQUEST_CONTEXT_TIMELINE_DEFAULT = 4;
/** The most timeline items per session a caller may ask for. */
export const REQUEST_CONTEXT_TIMELINE_MAX = 20;
/** Items listed per session for `aiCanDo` and `waiting` (`total` counts them all). */
export const REQUEST_CONTEXT_LIST_CAP = 3;

/** A part as read: the value, or that its read failed. */
export type RequestContextPart<T> =
  { status: "ok"; value: T } | { status: "unreadable" };

/** The parts a story may name as unreadable. */
export type RequestContextPartName =
  "timeline" | "aiCanDo" | "waiting" | "proposalWaits" | "subject";

/** The in-pod objects a request's subject may be (an `OutputRef`'s kinds). */
export const REQUEST_SUBJECT_KINDS = [
  "entity",
  "document",
  "view",
  "cell",
  "automation",
  "playbook",
] as const;
export type RequestSubjectKind = (typeof REQUEST_SUBJECT_KINDS)[number];

/**
 * What the request is about, as the reader may see it: an in-pod object
 * (its door is `{kind, id}`) or an external link.
 */
export type RequestSubject =
  | {
      kind: RequestSubjectKind;
      id: string;
      /** Its live title; null = it has none (a cell). */
      title: string | null;
      /** An entity's kind (`file`, `person`); absent for other objects. */
      profileSlug?: string;
      /** Its primary media, a REFERENCE the display door signs; absent = none. */
      media?: MediaRef;
    }
  | { kind: "url"; url: string };

export interface RequestSessionTimeline {
  /** Newest first, at most the asked number of items. */
  events: DevTimelineEvent[];
  /** Older events exist than those listed (the full timeline is the door). */
  olderExist: boolean;
}

export interface RequestAiCanDo {
  /** At most {@link REQUEST_CONTEXT_LIST_CAP}; answered first, as the packet orders it. */
  items: Array<{ label: string; answered: boolean }>;
  total: number;
}

export interface RequestWaitingSessions {
  /** Open sessions that wait on this one, at most {@link REQUEST_CONTEXT_LIST_CAP}. */
  items: Array<{ id: string; title: string; status: string }>;
  total: number;
}

/** One session's parts, shared by every row of that session. */
export interface RequestSessionContext {
  timeline: RequestContextPart<RequestSessionTimeline>;
  aiCanDo: RequestContextPart<RequestAiCanDo>;
  waiting: RequestContextPart<RequestWaitingSessions>;
}

/** One row's own parts. */
export interface RequestRowContext {
  /** The session the row came from; null = none the pod can name. */
  sessionId: string | null;
  /** An owed-slot row: its slot's label, so the story tells its own ask apart from the past. */
  slotLabel: string | null;
  /** A proposal row: the member ids the row stands for ([] otherwise). */
  proposalIds: string[];
  /** A proposal row only: does an agent wait on it (the first member that waits). */
  proposalWaits: RequestContextPart<ProposalWaits> | null;
  /**
   * What the request is about. ABSENT when it names no object, or names one
   * the reader cannot read; `unreadable` when the read failed.
   */
  subject?: RequestContextPart<RequestSubject>;
}

/** `signals.needsYou(...).context`, present only when asked for. */
export interface NeedsYouContextRead {
  /** Timeline items read per session. */
  timelineItems: number;
  /** By session id: every session a row names. */
  sessions: Record<string, RequestSessionContext>;
  /** By row id (`Signal.id`): every row of the page, every fold. */
  rows: Record<string, RequestRowContext>;
}
