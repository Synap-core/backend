/**
 * THE REQUEST STORY — one request (an agent's ask, a proposal, a session card)
 * told as one vertical story (option B, plan d717d6ac §1): what led to it
 * (BEFORE, oldest first, repeats grouped, capped), the decision itself (NOW),
 * and what moves once the person decides (AFTER: what it unblocks, the status
 * the thing it holds cannot reach yet, an agent that waits on it, sessions
 * that wait). Every line carries its door.
 *
 * ONE model for pod admin, the browser and relay; each draws it with its own
 * kit. Its inputs are the shared lens row (`lensRowOfNeedsYou`) and the page's
 * context read (`signals.needsYou({ include: ["context"] })`,
 * `NeedsYouContextRead`). A part whose read FAILED is named in `unreadable`
 * with its sentence: the story never draws a failed read as "nothing
 * happened" or "nothing waits".
 *
 * Pure. Words come from this folder's catalog (`./copy.ts`) and the
 * vocabulary; what agents and people wrote (a slot's label, a proposal's
 * summary, `unblocks`) is printed as written.
 */

import type { ActivityActor } from "../activity/index.js";
import type { Locale } from "../i18n/index.js";
import type {
  LensDoor,
  LensRow,
  LensRowBy,
  LensRowCause,
  LensVerb,
} from "../lens/rows.js";
import { FATE_COPY, type ProposalWaitReason } from "../proposals/fate.js";
import type {
  DevTimelineEvent,
  DevTimelineEventKind,
} from "../units/timeline.js";
import { resolveStatusLabel } from "../vocabulary/index.js";
import type { NeedsYouBlocks } from "./context.js";
import { needsYouT } from "./copy.js";
import type {
  NeedsYouContextRead,
  RequestContextPartName,
  RequestRowContext,
  RequestSessionContext,
  RequestSubject,
} from "./request-context.js";
import { REQUEST_CONTEXT_LIST_CAP } from "./request-context.js";

/** Groups of past events shown above Now; older ones fold into "N more events". */
export const REQUEST_STORY_BEFORE_CAP = 3;

// ─── Output ────────────────────────────────────────────────────────────────

/** A past line: one event, or the same thing happening several times in a row. */
export interface RequestStoryGroup {
  /** Stable: the group's newest event id. */
  key: string;
  kind: DevTimelineEventKind;
  /** The newest event of the group, in words. */
  line: string;
  /** How many events it stands for (1 = one event). */
  count: number;
  /** "3 times" when `count` > 1, else null. */
  repeat: string | null;
  /** When the newest event of the group happened (ISO). */
  at: string;
  /** Who acted in the newest event, named by the pod. */
  actor: ActivityActor;
  /** The line's object: a proposal, a session. Null = none addressable. */
  door: LensDoor | null;
  /** A pull request's or a CI run's page, when the event names one. */
  url: string | null;
  /** The events, oldest first: what the line opens onto. */
  events: DevTimelineEvent[];
}

export interface RequestStoryHead {
  /** Who asked, as a door (the lens row's `by`). */
  by: LensRowBy | null;
  /** What raised it when no agent did (the lens row's `cause`). */
  cause: LensRowCause | null;
  /** The session it came from: what the work is for. */
  session: { id: string; title: string; door: LensDoor } | null;
}

export interface RequestStoryNow {
  title: string;
  /** The ask's longer description, when it adds (the row's `detail`). */
  detail: string | null;
  /** When it was asked (ISO); null = unknown. */
  at: string | null;
  verb: LensVerb | null;
  door: LensDoor | null;
  /** What the agent works on while it waits; null = nothing said. */
  meanwhile: { label: string; text: string } | null;
  /**
   * What the request is about (the context's `subject`), with its door: the
   * object to show and open beside the ask. Null = it names none the reader
   * can see, or the read failed (then `unreadable` names it).
   */
  subject:
    (RequestSubject & { door: LensDoor | null; url: string | null }) | null;
}

export type RequestStoryStep =
  | {
      /** What the answer unblocks, in the agent's words. */
      kind: "unblocks";
      key: string;
      label: string;
      text: string;
      door: LensDoor | null;
    }
  | {
      /** The thing it holds up, and the status it cannot reach yet. */
      kind: "thing";
      key: string;
      /** "<thing> can move on"; null when the pod could not name the thing. */
      line: string | null;
      thing: NeedsYouBlocks["thing"];
      statusNow: NeedsYouBlocks["statusNow"];
      statusNext: NeedsYouBlocks["statusNext"];
      door: LensDoor;
    }
  | {
      /** An agent waits on this proposal (a gate, a slot it fills, a parked run). */
      kind: "agent_waits";
      key: string;
      reason: ProposalWaitReason;
      line: string;
      door: LensDoor | null;
    }
  | {
      /** Open sessions that wait on this one. */
      kind: "sessions_wait";
      key: string;
      line: string;
      total: number;
      /** At most {@link REQUEST_CONTEXT_LIST_CAP}. */
      sessions: Array<{
        id: string;
        title: string;
        status: string;
        door: LensDoor;
      }>;
    };

export interface RequestStory {
  head: RequestStoryHead;
  /** Oldest first, the {@link REQUEST_STORY_BEFORE_CAP} groups nearest Now. */
  before: RequestStoryGroup[];
  /** Older groups folded above `before`; null when nothing folds. */
  folded: { groups: number; events: number; label: string } | null;
  /** The session holds older events than were read: the full timeline is the door. */
  olderExist: boolean;
  /** The session's full story. Null = no session. */
  timelineDoor: LensDoor | null;
  now: RequestStoryNow;
  /** What moves once the person decides, in this order. */
  after: RequestStoryStep[];
  /** Parts whose read failed, each with its sentence. */
  unreadable: Array<{ part: RequestContextPartName; line: string }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const SESSION_KEY = "session:";

/** The session a lens row comes from: the context's, else its door or source. */
function sessionIdOf(
  row: LensRow,
  ctx: RequestRowContext | undefined
): string | null {
  if (ctx?.sessionId) return ctx.sessionId;
  if (row.door?.kind === "session") return row.door.id;
  if (row.source?.kind === "session") return row.source.id;
  return row.key.startsWith(SESSION_KEY)
    ? row.key.slice(SESSION_KEY.length)
    : null;
}

function eventDoor(e: DevTimelineEvent): LensDoor | null {
  if (e.refs.proposalId) return { kind: "proposal", id: e.refs.proposalId };
  if (e.refs.sessionId) return { kind: "session", id: e.refs.sessionId };
  return null;
}

/** Events of one line: the same kind about the same slot, PR or decision. */
function groupKey(e: DevTimelineEvent): string {
  switch (e.kind) {
    case "slot_asked":
    case "slot_answered":
    case "slot_attested":
    case "relay_corrected":
    case "question_withdrawn":
      return `${e.kind}:${e.slot ?? ""}`;
    case "pr_opened":
    case "pr_merged":
    case "pr_closed":
      return `${e.kind}:${e.pr.repo}#${e.pr.number}`;
    case "checks_finished":
      return `${e.kind}:${e.checks.result ?? ""}`;
    case "decision_answered":
      return `${e.kind}:${e.decision}`;
    default:
      return e.kind;
  }
}

/** One event in words. */
export function requestStoryLine(e: DevTimelineEvent, locale?: Locale): string {
  const t = needsYouT(locale);
  switch (e.kind) {
    case "session_started":
      return t("needsYou.story.sessionStarted");
    case "status_moved":
      return t("needsYou.story.statusMoved", {
        status: resolveStatusLabel(e.to, locale),
      });
    case "pr_opened":
      return t("needsYou.story.prOpened", {
        repo: e.pr.repo,
        number: String(e.pr.number),
      });
    case "pr_merged":
      return t("needsYou.story.prMerged", {
        repo: e.pr.repo,
        number: String(e.pr.number),
      });
    case "pr_closed":
      return t("needsYou.story.prClosed", {
        repo: e.pr.repo,
        number: String(e.pr.number),
      });
    case "checks_finished":
      return t("needsYou.story.checks", { result: e.checks.result ?? "other" });
    case "decision_asked":
      return t("needsYou.story.decisionAsked", {
        titled: e.title ? "yes" : "no",
        title: e.title ?? "",
      });
    case "decision_answered":
      return t("needsYou.story.decisionAnswered", {
        decision: e.decision,
        title: e.title ?? "",
      });
    case "slot_asked":
      return t("needsYou.story.slotAsked", { slot: e.slot });
    case "slot_answered":
      return t("needsYou.story.slotAnswered", { slot: e.slot });
    case "slot_attested":
      return t("needsYou.story.slotAttested", { slot: e.slot });
    case "relay_corrected":
      return t("needsYou.story.relayCorrected", {
        named: e.slot ? "yes" : "no",
        slot: e.slot ?? "",
      });
    case "question_withdrawn":
      return t("needsYou.story.questionWithdrawn", {
        named: e.slot ? "yes" : "no",
        slot: e.slot ?? "",
      });
  }
}

/** A subject and where it opens: an in-pod object's door, else its link. */
function subjectWithDoor(
  s: RequestSubject
): NonNullable<RequestStoryNow["subject"]> {
  if (s.kind === "url") return { ...s, door: null, url: s.url };
  return { ...s, door: { kind: s.kind, id: s.id }, url: null };
}

/** The request itself is Now, never a past line: its own ask, its own proposal. */
function isTheRequest(
  e: DevTimelineEvent,
  ctx: RequestRowContext | undefined
): boolean {
  if (!ctx) return false;
  if (e.kind === "slot_asked" && ctx.slotLabel && e.slot === ctx.slotLabel)
    return true;
  return (
    e.kind === "decision_asked" &&
    !!e.refs.proposalId &&
    ctx.proposalIds.includes(e.refs.proposalId)
  );
}

/** Consecutive events (oldest first) of one line become one group. */
export function groupRequestEvents(
  oldestFirst: readonly DevTimelineEvent[],
  locale?: Locale
): RequestStoryGroup[] {
  const runs: DevTimelineEvent[][] = [];
  for (const e of oldestFirst) {
    const last = runs.at(-1);
    if (last && groupKey(last[0]!) === groupKey(e)) last.push(e);
    else runs.push([e]);
  }
  const t = needsYouT(locale);
  return runs.map((events) => {
    const newest = events.at(-1)!;
    return {
      key: newest.id,
      kind: newest.kind,
      line: requestStoryLine(newest, locale),
      count: events.length,
      repeat:
        events.length > 1
          ? t("needsYou.story.repeat", { n: events.length })
          : null,
      at: newest.at,
      actor: newest.actor,
      door: eventDoor(newest),
      url: newest.refs.url ?? null,
      events,
    };
  });
}

// ─── The model ─────────────────────────────────────────────────────────────

/**
 * The story of one lens row (`lensRowOfNeedsYou`), from the page's context
 * read. Without a context read (`include` not asked) the story has a Now and
 * the After the row itself carries, no Before, and names nothing unreadable.
 */
export function requestStory(
  row: LensRow,
  context: NeedsYouContextRead | null | undefined,
  opts: { locale?: Locale } = {}
): RequestStory {
  const { locale } = opts;
  const t = needsYouT(locale);
  const rowCtx = context?.rows[row.key];
  const sessionId = sessionIdOf(row, rowCtx);
  const sessionCtx: RequestSessionContext | undefined =
    sessionId && context ? context.sessions[sessionId] : undefined;
  const unreadable: RequestStory["unreadable"] = [];
  const failed = (part: RequestContextPartName) =>
    unreadable.push({ part, line: t(`needsYou.story.unreadable.${part}`) });
  // A session the read was asked for and did not answer is a failed read,
  // never an empty story.
  const sessionMissing = !!context && !!sessionId && !sessionCtx;
  if (sessionMissing) {
    failed("timeline");
    failed("aiCanDo");
    failed("waiting");
  }

  const sessionDoor: LensDoor | null = sessionId
    ? { kind: "session", id: sessionId }
    : null;
  const sessionTitle =
    row.source?.kind === "session" && row.source.label
      ? row.source.label
      : row.objectKind === "session"
        ? row.title
        : null;
  const head: RequestStoryHead = {
    by: row.by ?? null,
    cause: row.cause ?? null,
    session:
      sessionId && sessionDoor && sessionTitle
        ? { id: sessionId, title: sessionTitle, door: sessionDoor }
        : null,
  };

  // BEFORE
  let before: RequestStoryGroup[] = [];
  let folded: RequestStory["folded"] = null;
  let olderExist = false;
  if (sessionCtx) {
    if (sessionCtx.timeline.status === "ok") {
      const past = [...sessionCtx.timeline.value.events]
        .filter((e) => !isTheRequest(e, rowCtx))
        .reverse();
      const groups = groupRequestEvents(past, locale);
      const hidden = groups.slice(
        0,
        Math.max(0, groups.length - REQUEST_STORY_BEFORE_CAP)
      );
      before = groups.slice(hidden.length);
      if (hidden.length > 0) {
        const events = hidden.reduce((n, g) => n + g.count, 0);
        folded = {
          groups: hidden.length,
          events,
          label: t("needsYou.story.moreEvents", { n: events }),
        };
      }
      olderExist = sessionCtx.timeline.value.olderExist;
    } else {
      failed("timeline");
    }
  }

  // NOW
  let meanwhile: RequestStoryNow["meanwhile"] = null;
  if (sessionCtx) {
    if (sessionCtx.aiCanDo.status === "ok") {
      const own = rowCtx?.slotLabel ?? null;
      const item = sessionCtx.aiCanDo.value.items.find(
        (i) => i.label.trim() && i.label !== own
      );
      if (item)
        meanwhile = {
          label: t("needsYou.story.meanwhile"),
          text: item.label.trim(),
        };
    } else {
      failed("aiCanDo");
    }
  }
  let subject: RequestStoryNow["subject"] = null;
  if (rowCtx?.subject) {
    if (rowCtx.subject.status === "unreadable") failed("subject");
    else subject = subjectWithDoor(rowCtx.subject.value);
  }
  const now: RequestStoryNow = {
    title: row.title,
    detail: row.detail?.trim() || null,
    at: row.occurredAt,
    verb: row.verb,
    door: row.door,
    meanwhile,
    subject,
  };

  // AFTER
  const after: RequestStoryStep[] = [];
  if (row.unblocks?.trim()) {
    after.push({
      kind: "unblocks",
      key: "unblocks",
      label: t("needsYou.story.unblocks"),
      text: row.unblocks.trim(),
      door: sessionDoor,
    });
  }
  if (row.blocks) {
    const name = row.blocks.thing.name?.trim() || null;
    after.push({
      kind: "thing",
      key: `thing:${row.blocks.thing.id}`,
      line: name ? t("needsYou.story.thingMoves", { thing: name }) : null,
      thing: row.blocks.thing,
      statusNow: row.blocks.statusNow,
      statusNext: row.blocks.statusNext,
      door: { kind: "entity", id: row.blocks.thing.id },
    });
  }
  if (rowCtx?.proposalWaits) {
    const waits = rowCtx.proposalWaits;
    if (waits.status === "unreadable") failed("proposalWaits");
    else if (waits.value.waits && waits.value.reason) {
      after.push({
        kind: "agent_waits",
        key: `waits:${waits.value.reason}`,
        reason: waits.value.reason,
        line: FATE_COPY.waitReason[waits.value.reason],
        door: sessionDoor,
      });
    }
  }
  if (sessionCtx) {
    if (sessionCtx.waiting.status === "ok") {
      const { items, total } = sessionCtx.waiting.value;
      if (total > 0) {
        after.push({
          kind: "sessions_wait",
          key: "sessions-wait",
          line: t("needsYou.story.sessionsWait", { n: total }),
          total,
          sessions: items.slice(0, REQUEST_CONTEXT_LIST_CAP).map((s) => ({
            ...s,
            door: { kind: "session", id: s.id },
          })),
        });
      }
    } else {
      failed("waiting");
    }
  }

  return {
    head,
    before,
    folded,
    olderExist,
    timelineDoor: sessionDoor,
    now,
    after,
    unreadable,
  };
}
