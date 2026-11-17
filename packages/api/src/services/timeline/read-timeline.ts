/**
 * readTimeline — THE timeline read: what happened to a goal, a session or a
 * pull request, newest first (`TimelineWire`, `@synap-core/types/units`).
 * Hub `GET /timeline`, MCP `synap_get_timeline`.
 *
 * ── THE HONEST SOURCE OF EACH SUBJECT ───────────────────────────────────────
 *   goal          the goal history read (`readTrackHistory`, the read behind
 *                 tRPC `tracks.history`), unchanged — one goal history.
 *   session       `session_started` — the row (`started_at`, else created);
 *                 `status_moved` — the transition log
 *                     (`lifecycle_transition_outbox`): written in the SAME
 *                     transaction as the move, kept after delivery, carrying
 *                     the hold and the move's own occurred time (the `events`
 *                     row of a session move carries its DELIVERY time, up to
 *                     ~90 s late);
 *                 `pr_*`, `checks_finished` — the session's dev facts
 *                     (`sessionDevFactWhere`, the change feed's rule), at the
 *                     time they happened, `recordedAt` when the pod heard late;
 *                 `decision_asked` / `decision_answered` — the proposals filed
 *                     in it (pending; decided by a PERSON), as the goal history;
 *                 `slot_asked` / `slot_answered` / `slot_attested` /
 *                     `relay_corrected` / `question_withdrawn` /
 *                     `slot_handed_back` — its slots'
 *                     history rows (`focus_session.slot_*`, under the events
 *                     floor), written by the ask doors in the same transaction
 *                     as the change;
 *                 THE CHAIN (decision D3, the Operations session lens):
 *                 `stage_moved` — the stage ledger on the row
 *                     (`stage_history`, 0382), never the transition log;
 *                 `child_started` — a `spawned_from` link to it, the child
 *                     under the reader's session floor;
 *                 `runner_seen` — each runner row (0342) at its first sight,
 *                     with its state NOW (no state history is kept);
 *                 `room_post` — its room's posts (a person's message, an
 *                     agent's question or update, a session_message in) and
 *                     the session_messages it sent, under the channel floor,
 *                     as ONE line (`timelinePostLine`, 120 characters) with
 *                     the message and room ids: never the body.
 *                 One session or a page of them: {@link readSessionTimelines}.
 *   pull_request  its `dev.pr_*` facts, and the CI runs that name it or ran on
 *                 a head sha one of them named (the PR fold's own rule).
 *   entity        a thing's status moves — its own and those of the roles it
 *                 wears that the reader may see (`readThingRoles`, THE facet
 *                 visibility rule) — from the transition log, with their
 *                 holds. Under the entity read floor. No door names this
 *                 subject; `statusOf`'s `include: ["history"]` reads it.
 *
 * Owner-floored like every agent door (`sessionReadableWhere` owner-only, the
 * events floor; a workspace-bound key's `lens` narrows both): missing and
 * not-yours are the same `null`. A FAILED source
 * read THROWS — a partial timeline must not read as a quiet one. Each source
 * reads at most {@link TIMELINE_SOURCE_CAP} rows, newest first; hitting it
 * sets `truncated`.
 */

import {
  and,
  channels,
  db,
  desc,
  drizzleSql,
  entities,
  eq,
  events,
  focusSessions,
  gte,
  inArray,
  isNotNull,
  isNull,
  lifecycleTransitionOutbox,
  links,
  lte,
  MessageAuthorType,
  MessageCategory,
  MessageRole,
  messages,
  or,
  proposals,
  readSessionStageHistory,
  sessionRunners,
  type SQL,
} from "@synap/database";
import {
  DEV_LOOP_EVENT_TYPES,
  ciVerdictOf,
  devboxJobOf,
  parsePullRequestRef,
  pullRequestUrl,
  sameCommit,
  samePullRequest,
  type CiFinishedStatus,
  type PullRequestRef,
} from "@synap-core/types";
import type { ActivityActor } from "@synap-core/types/activity";
import {
  readSessionPost,
  SESSION_POST_META_KEY,
} from "@synap-core/types/agents";
import { readRoomPostMeta } from "@synap-core/types/ask";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { TransitionBase } from "@synap-core/types/lifecycle";
import {
  timelinePostLine,
  timelineRecordedAt,
  type DevTimelineEvent,
  type DevTimelineRefs,
  type TimelineWire,
} from "@synap-core/types/units";

import {
  decisionEvents,
  decisionRowsWhere,
} from "../activity/decision-events.js";
import { eventVisibleWhere } from "../../access/event-visibility.js";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { activityActorOf, loadActorRows } from "../activity/activity-actors.js";
import {
  sessionDevFactWhere,
  sessionPullRequestRefs,
  unstampedPullRequestFactWhere,
} from "../focus-sessions/session-changes.js";
import {
  FOCUS_SESSION_QUESTION_WITHDRAWN_EVENT_TYPE,
  FOCUS_SESSION_RELAY_CORRECTED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_ATTESTED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_HANDED_BACK_EVENT_TYPE,
  FOCUS_SESSION_SUBJECT_TYPE,
} from "../focus-sessions/lifecycle-events.js";
import { readTrackHistory } from "../tracks/track-history.js";
import { readThingRoles } from "../status/status-roles.js";
import type { TrackActor } from "../tracks/tracks-service.js";
import { isUuid } from "@synap-core/types/property-render";

/** Rows read per source. Hitting it sets `truncated` — older rows exist. */
export const TIMELINE_SOURCE_CAP = 500;

export type TimelineSubject =
  | { kind: "goal"; id: string }
  | { kind: "session"; id: string }
  | { kind: "entity"; id: string }
  | { kind: "pull_request"; ref: PullRequestRef };

/**
 * The ONE subject a door's arguments name (Hub query, MCP args), or why they
 * name none — one parser, so the two doors cannot drift.
 */
export function timelineSubjectOf(query: {
  goalId?: string;
  sessionId?: string;
  pr?: string;
}): { ok: true; subject: TimelineSubject } | { ok: false; error: string } {
  const given = [query.goalId, query.sessionId, query.pr].filter(
    (v) => v !== undefined && v !== ""
  );
  if (given.length !== 1) {
    return {
      ok: false,
      error: "Name exactly one of goalId, sessionId or pr (`owner/name#n`).",
    };
  }
  if (query.goalId) {
    return isUuid(query.goalId)
      ? { ok: true, subject: { kind: "goal", id: query.goalId } }
      : { ok: false, error: "goalId must be a UUID." };
  }
  if (query.sessionId) {
    return isUuid(query.sessionId)
      ? { ok: true, subject: { kind: "session", id: query.sessionId } }
      : { ok: false, error: "sessionId must be a UUID." };
  }
  const ref = parsePullRequestRef(query.pr!);
  return ref
    ? { ok: true, subject: { kind: "pull_request", ref } }
    : {
        ok: false,
        error: "pr must be `owner/name#n` or a GitHub pull request url.",
      };
}

const SYSTEM: ActivityActor = { kind: "system", id: null, name: null };

const PR_FACT_KIND: Readonly<
  Record<string, "pr_opened" | "pr_merged" | "pr_closed">
> = {
  [DEV_LOOP_EVENT_TYPES.prOpened]: "pr_opened",
  [DEV_LOOP_EVENT_TYPES.prMerged]: "pr_merged",
  [DEV_LOOP_EVENT_TYPES.prClosed]: "pr_closed",
};
const DEV_FACT_TYPES = [
  ...Object.keys(PR_FACT_KIND),
  DEV_LOOP_EVENT_TYPES.ciFinished,
];

/** An event before its actor is named (named in ONE batch at the end). */
type Unnamed<E> = E extends unknown
  ? Omit<E, "actor"> & { actor?: ActivityActor }
  : never;
interface Pending {
  event: Unnamed<DevTimelineEvent>;
  actorId: string | null;
  isAgent: boolean;
  /** A runner's computer (`machine` user), named in the same users read. */
  computerId?: string | null;
}

interface DevFactRow {
  id: string;
  type: string;
  timestamp: Date;
  data: unknown;
}

const iso = (d: Date | string) => new Date(d).toISOString();

/** One dev fact as a timeline event; null when the row is not one. */
function devFactEvent(row: DevFactRow): Pending | null {
  const d = (row.data ?? {}) as Record<string, unknown>;
  const repo = typeof d.repo === "string" ? d.repo : null;
  if (!repo) return null;
  const at = iso(row.timestamp);
  const recorded = timelineRecordedAt(
    at,
    typeof d.ingestedAt === "string" ? d.ingestedAt : null
  );
  const prKind = PR_FACT_KIND[row.type];
  if (prKind) {
    if (typeof d.number !== "number" || typeof d.url !== "string") return null;
    return {
      event: {
        id: `event:${row.id}`,
        kind: prKind,
        at,
        ...recorded,
        actor: SYSTEM,
        refs: { url: d.url },
        pr: {
          repo,
          number: d.number,
          url: d.url,
          title: typeof d.title === "string" && d.title ? d.title : null,
        },
        intoDefault: typeof d.intoDefault === "boolean" ? d.intoDefault : null,
      },
      actorId: null,
      isAgent: false,
    };
  }
  const sha = typeof d.sha === "string" ? d.sha : null;
  if (!sha || typeof d.status !== "string") return null;
  const status = d.status as CiFinishedStatus;
  const workflow = typeof d.workflow === "string" ? d.workflow : null;
  const pr = typeof d.pr === "number" ? d.pr : null;
  return {
    event: {
      id: `event:${row.id}`,
      kind: "checks_finished",
      at,
      ...recorded,
      actor: SYSTEM,
      refs:
        typeof d.url === "string"
          ? { url: d.url }
          : pr !== null
            ? { url: pullRequestUrl({ repo, number: pr }) }
            : {},
      checks: {
        repo,
        sha,
        result: ciVerdictOf(status) ?? null,
        status,
        pr,
        job: devboxJobOf(workflow),
        workflow,
      },
    },
    actorId: null,
    isAgent: false,
  };
}

/** Name every actor in one read; newest first. */
async function finish(
  out: readonly Pending[],
  viewer: string
): Promise<DevTimelineEvent[]> {
  const rows = await loadActorRows(
    out.flatMap((p) => [p.actorId, p.computerId])
  );
  const named = out.map((p) => {
    const e = {
      ...p.event,
      actor:
        p.event.actor ??
        activityActorOf(
          p.actorId,
          p.actorId ? rows.get(p.actorId) : undefined,
          viewer,
          p.isAgent
        ),
    } as DevTimelineEvent;
    const computer = p.computerId ? rows.get(p.computerId)?.name : null;
    return e.kind === "runner_seen" && computer
      ? { ...e, runner: { ...e.runner, computer } }
      : e;
  });
  named.sort((a, b) => {
    const t = Date.parse(b.at) - Date.parse(a.at);
    if (t !== 0) return t;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return named;
}

/** Who reads: the goal history's actor, plus a bound key's workspace. */
export type TimelineReader = TrackActor & { lens?: string };

export async function readTimeline(
  subject: TimelineSubject,
  actor: TimelineReader
): Promise<TimelineWire | null> {
  if (subject.kind === "goal") {
    const history = await readTrackHistory(subject.id, actor);
    if (!history) return null;
    return {
      subject: { kind: "goal", id: history.trackId },
      events: history.events,
      truncated: history.truncated,
    };
  }
  if (subject.kind === "session") return readSessionTimeline(subject.id, actor);
  if (subject.kind === "entity") return readEntityTimeline(subject.id, actor);
  return readPullRequestTimeline(subject.ref, actor);
}

/** A status move off the transition log, as a timeline event. */
function statusMovedEvent(
  r: { id: string; transition: unknown; createdAt: Date | string },
  refs: DevTimelineRefs
): Pending | null {
  const t = (
    typeof r.transition === "string" ? JSON.parse(r.transition) : r.transition
  ) as TransitionBase & { role?: string | null };
  if (typeof t?.to !== "string") return null;
  // A row owed before moves stamped their times (W4) has only its own.
  const recordedAt = t.recordedAt ?? iso(r.createdAt);
  const at = iso(t.occurredAt ?? recordedAt);
  return {
    event: {
      id: `transition:${r.id}`,
      kind: "status_moved",
      at,
      ...timelineRecordedAt(at, recordedAt),
      refs,
      from: t.from ?? null,
      to: t.to,
      category: t.category,
      reason: t.reason ?? null,
      hold: t.hold ?? null,
      ...(t.role ? { role: t.role } : {}),
      // "Moved because X moved": the move that caused it.
      ...(t.cause ? { cause: t.cause } : {}),
      ...(t.actorKind === "system" ? { actor: SYSTEM } : {}),
    },
    actorId: t.actorKind === "agent" ? t.agentUserId : t.userId,
    isAgent: t.actorKind === "agent",
  };
}

async function readEntityTimeline(
  entityId: string,
  actor: TimelineReader
): Promise<TimelineWire | null> {
  const [thing] = await db
    .select({ id: entities.id, title: entities.title })
    .from(entities)
    .where(
      and(
        eq(entities.id, entityId),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(actor.userId)
      )
    )
    .limit(1);
  if (!thing) return null;
  const cap = TIMELINE_SOURCE_CAP;
  const outbox = lifecycleTransitionOutbox;
  const [rows, roles] = await Promise.all([
    db
      .select({
        id: outbox.transitionId,
        transition: outbox.transition,
        createdAt: outbox.createdAt,
      })
      .from(outbox)
      .where(
        and(
          // The subject index (0374): coalesce(subjectId, entityId), created_at.
          drizzleSql`coalesce(${outbox.transition}->>'subjectId', ${outbox.transition}->>'entityId') = ${thing.id}`,
          drizzleSql`${outbox.transition}->>'subjectType' = 'entity'`
        )
      )
      .orderBy(desc(outbox.createdAt))
      .limit(cap + 1),
    readThingRoles(actor.userId, [thing.id]),
  ]);
  // A role's move is shown only when the reader may see that role.
  const visibleFacets = new Set(
    (roles.get(thing.id) ?? []).map((r) => r.facetId)
  );
  const out: Pending[] = [];
  for (const r of rows.slice(0, cap)) {
    const t = (
      typeof r.transition === "string" ? JSON.parse(r.transition) : r.transition
    ) as { facetId?: string | null } | null;
    if (t?.facetId && !visibleFacets.has(t.facetId)) continue;
    const e = statusMovedEvent(r, {});
    if (e) out.push(e);
  }
  return {
    subject: { kind: "entity", id: thing.id, title: thing.title ?? null },
    events: await finish(out, actor.userId),
    truncated: rows.length > cap,
  };
}

/** A slot history row's type → its timeline kind (`lifecycle-events.ts`). */
const SLOT_EVENT_KIND: Readonly<
  Record<
    string,
    | "slot_asked"
    | "slot_answered"
    | "slot_attested"
    | "relay_corrected"
    | "question_withdrawn"
    | "slot_handed_back"
  >
> = {
  [FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE]: "slot_asked",
  [FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE]: "slot_answered",
  [FOCUS_SESSION_SLOT_ATTESTED_EVENT_TYPE]: "slot_attested",
  [FOCUS_SESSION_RELAY_CORRECTED_EVENT_TYPE]: "relay_corrected",
  [FOCUS_SESSION_QUESTION_WITHDRAWN_EVENT_TYPE]: "question_withdrawn",
  [FOCUS_SESSION_SLOT_HANDED_BACK_EVENT_TYPE]: "slot_handed_back",
};
const SLOT_EVENT_TYPES = Object.keys(SLOT_EVENT_KIND);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

/**
 * One slot history row (`focus_session.slot_*`, written by the door that made
 * the change) as a timeline event; null when the row is not one. The actor
 * is who ACTED: the asking agent (else the pod), the person who answered or
 * attested or corrected or handed it back ("Not mine"), the agent that
 * withdrew.
 */
function slotEvent(
  row: DevFactRow & { userId: string },
  sessionId: string
): Pending | null {
  const kind = SLOT_EVENT_KIND[row.type];
  if (!kind) return null;
  const d = (row.data ?? {}) as Record<string, unknown>;
  const slot = str(d.expectedLabel);
  const base = {
    id: `event:${row.id}`,
    at: iso(row.timestamp),
    refs: { sessionId, ...(slot ? { slotLabel: slot } : {}) },
  };
  switch (kind) {
    case "slot_asked": {
      if (!slot) return null;
      const ask = (d.ask ?? null) as { mode?: unknown } | null;
      const agent = str(d.askedByAgentUserId);
      return {
        event: {
          ...base,
          kind,
          slot,
          askMode: str(ask?.mode),
          blockedReason: str(d.blockedReason),
          ...(agent ? {} : { actor: SYSTEM }),
        },
        actorId: agent,
        isAgent: Boolean(agent),
      };
    }
    case "slot_answered": {
      if (!slot) return null;
      const value = (d.value ?? null) as { type?: unknown } | null;
      return {
        event: {
          ...base,
          kind,
          slot,
          answerType: str(value?.type),
          handedBack: d.handedBack === true,
          relayed: d.via === "relayed" || Boolean(str(d.relayedBy)),
        },
        actorId: str(d.answeredBy) ?? row.userId,
        isAgent: false,
      };
    }
    case "slot_attested":
      if (!slot) return null;
      return {
        event: { ...base, kind, slot },
        actorId: str(d.attestedBy) ?? row.userId,
        isAgent: false,
      };
    case "relay_corrected":
      return {
        event: { ...base, kind, slot },
        actorId: row.userId,
        isAgent: false,
      };
    case "slot_handed_back":
      if (!slot) return null;
      return {
        event: { ...base, kind, slot },
        actorId: str(d.handedBackBy) ?? row.userId,
        isAgent: false,
      };
    case "question_withdrawn": {
      const agent = str(d.withdrawnBy);
      return {
        event: {
          ...base,
          kind,
          slot,
          note: str(d.note),
          ...(agent ? {} : { actor: SYSTEM }),
        },
        actorId: agent,
        isAgent: Boolean(agent),
      };
    }
  }
}

/** Characters of a post read to cut its line: the body never leaves SQL. */
const POST_HEAD_CHARS = 600;

interface PostRow {
  id: string;
  channelId: string;
  head: string;
  long: boolean;
  role: string;
  authorType: string;
  userId: string;
  routedTeammateId: string | null;
  metadata: unknown;
  timestamp: Date | string;
}

/**
 * A room post as a one-line reference (decision D3): the post's form, the
 * first line of its text ({@link timelinePostLine}), its message and room.
 * `sessionId` is the session whose chain it joins: a session_message it
 * RECEIVED (`in`, addressed to it, sent by another session's agent under that
 * agent's own attribution, the inbox rule) or SENT (`out`).
 */
function roomPostEvent(row: PostRow, sessionId: string): Pending {
  const meta = readSessionPost(row.metadata);
  const agent =
    row.authorType === MessageAuthorType.AI_AGENT ? row.routedTeammateId : null;
  const attributed = Boolean(meta && agent && agent === meta.from.agentUserId);
  const direction: "in" | "out" | null =
    meta && attributed && meta.from.sessionId !== meta.to.sessionId
      ? meta.to.sessionId === sessionId
        ? "in"
        : meta.from.sessionId === sessionId
          ? "out"
          : null
      : null;
  const form = direction
    ? "session_message"
    : row.authorType === MessageAuthorType.AI_AGENT
      ? (readRoomPostMeta(row.metadata)?.kind ?? "update")
      : "person";
  const { line, truncated } = timelinePostLine(row.head);
  // The OTHER session of a session_message is the door; else this one.
  const other =
    direction === "in"
      ? meta!.from.sessionId
      : direction === "out"
        ? meta!.to.sessionId
        : null;
  return {
    event: {
      id: `message:${row.id}`,
      kind: "room_post",
      at: iso(row.timestamp),
      refs: {
        sessionId: other ?? sessionId,
        messageId: row.id,
        channelId: row.channelId,
      },
      post: {
        form,
        direction,
        intent: direction ? meta!.intent : null,
        line,
        truncated: truncated || row.long,
      },
    },
    actorId: agent ?? row.userId,
    isAgent: Boolean(agent),
  };
}

/** The `row_number()` of a row within its session, newest first. */
function rankIn(partition: SQL, order: SQL) {
  return drizzleSql<number>`row_number() over (partition by ${partition} order by ${order} desc)`;
}

/** One session's timeline as {@link readSessionTimelines} returns it. */
export interface SessionTimelineRead {
  title: string;
  /** Newest first, every source merged. */
  events: DevTimelineEvent[];
  /** A source held more than `perSource` rows: older events exist. */
  truncated: boolean;
}

/**
 * THE session timeline, for one session or a PAGE of them, in a fixed number
 * of queries whatever the page size: the session rows, then ONE read per
 * source (moves, dev facts, decisions, slot history, children, runners, room
 * posts, sent posts) ranked per session by a window, then ONE actor read.
 * The stage ledger rides on the session row; room posts are ranked per room. Each source keeps at most `perSource` rows per
 * session, newest first; one more than that sets `truncated`. The one-session
 * door ({@link readTimeline}) is this with `perSource` = the source cap, so
 * the door and a page's tails cannot project a session differently.
 *
 * A dev fact that names NO session and is about a PR two sessions of the page
 * both declared is attributed to the first of them here (the one-session door
 * shows it in each).
 *
 * Missing and not-yours sessions are absent from the map. A FAILED source
 * read THROWS.
 */
export async function readSessionTimelines(
  sessionIds: readonly string[],
  actor: TimelineReader,
  perSource: number = TIMELINE_SOURCE_CAP
): Promise<Map<string, SessionTimelineRead>> {
  const ids = [...new Set(sessionIds.filter(isUuid))];
  const out = new Map<string, SessionTimelineRead>();
  if (ids.length === 0) return out;
  const sessions = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      userId: focusSessions.userId,
      origin: focusSessions.origin,
      agentId: drizzleSql<
        string | null
      >`(${focusSessions.metadata}->>'agentUserId')`,
      startedAt: focusSessions.startedAt,
      createdAt: focusSessions.createdAt,
      expectedOutputs: focusSessions.expectedOutputs,
      channelId: focusSessions.channelId,
      stageHistory: focusSessions.stageHistory,
    })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.id, ids),
        sessionReadableWhere({ userId: actor.userId, lens: actor.lens })
      )
    );
  if (sessions.length === 0) return out;
  const readable = sessions.map((s) => s.id);
  const limit = perSource + 1;
  const outbox = lifecycleTransitionOutbox;

  // Moves: the subject index (0374), coalesce(subjectId, entityId).
  const moveSubject = drizzleSql`coalesce(${outbox.transition}->>'subjectId', ${outbox.transition}->>'entityId')`;
  const movesRanked = db
    .select({
      id: outbox.transitionId,
      transition: outbox.transition,
      createdAt: outbox.createdAt,
      owner: drizzleSql<string>`${moveSubject}`.as("owner"),
      rank: rankIn(moveSubject, drizzleSql`${outbox.createdAt}`).as("rank"),
    })
    .from(outbox)
    .where(
      and(
        inArray(moveSubject, readable),
        drizzleSql`${outbox.transition}->>'subjectType' = 'focus_session'`
      )
    )
    .as("moves_ranked");

  // Dev facts: the fact names one of these sessions, else it is about a PR
  // one of them declared (`sessionDevFactWhere`, clause by clause).
  const refsOf = sessions.map((s) => ({
    id: s.id,
    refs: sessionPullRequestRefs(s.expectedOutputs),
  }));
  const stamped = drizzleSql`${events.data}->>'sessionId'`;
  const factOwner = drizzleSql`case when ${inArray(stamped, readable)} then ${stamped}${drizzleSql.join(
    refsOf.flatMap(({ id, refs }) =>
      refs.map(
        (r) =>
          drizzleSql` when ${unstampedPullRequestFactWhere(r)} then ${id}::text`
      )
    ),
    drizzleSql``
  )} end`;
  const factsRanked = db
    .select({
      id: events.id,
      type: events.type,
      timestamp: events.timestamp,
      data: events.data,
      owner: drizzleSql<string>`${factOwner}`.as("owner"),
      rank: rankIn(factOwner, drizzleSql`${events.timestamp}`).as("rank"),
    })
    .from(events)
    .where(
      and(
        inArray(events.type, DEV_FACT_TYPES),
        or(...refsOf.map(({ id, refs }) => sessionDevFactWhere(id, refs))),
        eventVisibleWhere({
          userId: actor.userId,
          roster: false,
          lens: actor.lens,
        })
      )
    )
    .as("facts_ranked");

  const decisionsRanked = db
    .select({
      id: proposals.id,
      sessionId: proposals.sessionId,
      status: proposals.status,
      createdAt: proposals.createdAt,
      reviewedAt: proposals.reviewedAt,
      reviewedBy: proposals.reviewedBy,
      agentUserId: proposals.agentUserId,
      authorId: drizzleSql<
        string | null
      >`coalesce(${proposals.agentUserId}, ${proposals.proposedByUserId}, ${proposals.createdBy})`.as(
        "author_id"
      ),
      summary: drizzleSql<
        string | null
      >`coalesce(nullif(${proposals.data}->>'_summary', ''), nullif(${proposals.data}->>'summary', ''))`.as(
        "summary"
      ),
      rejectionReason: proposals.rejectionReason,
      comments: proposals.comments,
      rank: rankIn(
        drizzleSql`${proposals.sessionId}`,
        drizzleSql`${proposals.createdAt}`
      ).as("rank"),
    })
    .from(proposals)
    .where(and(inArray(proposals.sessionId, readable), decisionRowsWhere))
    .as("decisions_ranked");

  // The slots' history: the rows the ask doors write on the session.
  const slotsRanked = db
    .select({
      id: events.id,
      type: events.type,
      timestamp: events.timestamp,
      data: events.data,
      userId: events.userId,
      owner: drizzleSql<string>`${events.subjectId}`.as("owner"),
      rank: rankIn(
        drizzleSql`${events.subjectId}`,
        drizzleSql`${events.timestamp}`
      ).as("rank"),
    })
    .from(events)
    .where(
      and(
        inArray(events.type, SLOT_EVENT_TYPES),
        eq(events.subjectType, FOCUS_SESSION_SUBJECT_TYPE),
        inArray(events.subjectId, readable),
        eventVisibleWhere({
          userId: actor.userId,
          roster: false,
          lens: actor.lens,
        })
      )
    )
    .as("slots_ranked");

  // ── The session CHAIN (decision D3): spawns, runners, room posts ──────
  const floor = { userId: actor.userId, lens: actor.lens };

  // Spawned children: `child --spawned_from--> parent` (`session-spawn.ts`),
  // each child under the reader's own session floor.
  const childrenRanked = db
    .select({
      id: links.id,
      createdAt: links.createdAt,
      createdBy: links.createdBy,
      childId: drizzleSql<string>`${focusSessions.id}`.as("child_id"),
      childTitle: drizzleSql<string | null>`${focusSessions.title}`.as(
        "child_title"
      ),
      childGoal: drizzleSql<string>`${focusSessions.goal}`.as("child_goal"),
      childStatus: drizzleSql<string>`${focusSessions.status}`.as(
        "child_status"
      ),
      owner: drizzleSql<string>`${links.toId}`.as("owner"),
      rank: rankIn(
        drizzleSql`${links.toId}`,
        drizzleSql`${links.createdAt}`
      ).as("rank"),
    })
    .from(links)
    .innerJoin(
      focusSessions,
      eq(drizzleSql`${focusSessions.id}::text`, links.fromId)
    )
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "session"),
        eq(links.linkType, "spawned_from"),
        inArray(links.toId, readable),
        sessionReadableWhere(floor)
      )
    )
    .as("children_ranked");

  // Runners: one row per process of a client conversation (0342), each an
  // event at its first sight. Their state is now, never a history (none kept).
  const runnersRanked = db
    .select({
      owner: drizzleSql<string>`${sessionRunners.sessionId}::text`.as("owner"),
      clientKey: sessionRunners.clientKey,
      processKey: sessionRunners.processKey,
      harness: sessionRunners.harness,
      conversationId: sessionRunners.conversationId,
      agentUserId: sessionRunners.agentUserId,
      machineUserId: sessionRunners.machineUserId,
      processHost: sessionRunners.processHost,
      state: sessionRunners.state,
      model: sessionRunners.model,
      provider: sessionRunners.provider,
      firstSeenAt: sessionRunners.firstSeenAt,
      lastSeenAt: sessionRunners.lastSeenAt,
      rank: rankIn(
        drizzleSql`${sessionRunners.sessionId}`,
        drizzleSql`${sessionRunners.firstSeenAt}`
      ).as("rank"),
    })
    .from(sessionRunners)
    .where(inArray(sessionRunners.sessionId, readable))
    .as("runners_ranked");

  // Room posts: the sessions' rooms, under the channel floor. A person's
  // message or an agent's post; never a comment, a pod notice or an
  // ephemeral row. Only the head of the text is read (one line is shown).
  const sessionsOfRoom = new Map<string, string[]>();
  for (const s of sessions) {
    if (!s.channelId) continue;
    sessionsOfRoom.set(s.channelId, [
      ...(sessionsOfRoom.get(s.channelId) ?? []),
      s.id,
    ]);
  }
  const visibleRooms = db
    .select({ id: channels.id })
    .from(channels)
    .where(channelVisibilityWhere(actor.userId));
  const postSelect = {
    id: messages.id,
    channelId: messages.channelId,
    head: drizzleSql<string>`left(${messages.content}, ${POST_HEAD_CHARS})`.as(
      "head"
    ),
    long: drizzleSql<boolean>`char_length(${messages.content}) > ${POST_HEAD_CHARS}`.as(
      "long"
    ),
    role: messages.role,
    authorType: messages.authorType,
    userId: messages.userId,
    routedTeammateId: messages.routedTeammateId,
    metadata: messages.metadata,
    timestamp: messages.timestamp,
  };
  const postLive = and(
    isNull(messages.deletedAt),
    eq(messages.ephemeral, false),
    eq(messages.messageCategory, MessageCategory.CHAT),
    inArray(messages.channelId, visibleRooms)
  );
  const rooms = [...sessionsOfRoom.keys()];
  const postsRanked = db
    .select({
      ...postSelect,
      owner: drizzleSql<string>`${messages.channelId}::text`.as("owner"),
      rank: rankIn(
        drizzleSql`${messages.channelId}`,
        drizzleSql`${messages.timestamp}`
      ).as("rank"),
    })
    .from(messages)
    .where(
      and(
        inArray(messages.channelId, rooms),
        postLive,
        or(
          and(
            eq(messages.role, MessageRole.USER),
            eq(messages.authorType, MessageAuthorType.HUMAN)
          ),
          eq(messages.authorType, MessageAuthorType.AI_AGENT)
        )
      )
    )
    .as("posts_ranked");

  // Posts a session SENT to another session's room (`sessionPost.from`),
  // under the sender agent's own attribution (the inbox rule), into a room of
  // a session the reader may read. Bounded below by the page's oldest start.
  const sent = drizzleSql`${messages.metadata}->${SESSION_POST_META_KEY}`;
  const sentFrom = drizzleSql`${sent}->'from'->>'sessionId'`;
  const oldest = new Date(
    Math.min(...sessions.map((s) => new Date(s.createdAt).getTime()))
  );
  const sentRanked = db
    .select({
      ...postSelect,
      owner: drizzleSql<string>`${sentFrom}`.as("owner"),
      rank: rankIn(sentFrom, drizzleSql`${messages.timestamp}`).as("rank"),
    })
    .from(messages)
    .where(
      and(
        eq(messages.authorType, MessageAuthorType.AI_AGENT),
        inArray(sentFrom, readable),
        drizzleSql`coalesce(${sent}->'to'->>'sessionId', '') <> ${sentFrom}`,
        drizzleSql`${messages.routedTeammateId} = ${sent}->'from'->>'agentUserId'`,
        gte(messages.timestamp, oldest),
        postLive,
        inArray(
          messages.channelId,
          db
            .select({ id: drizzleSql`${focusSessions.channelId}` })
            .from(focusSessions)
            .where(
              and(
                isNotNull(focusSessions.channelId),
                sessionReadableWhere(floor)
              )
            )
        )
      )
    )
    .as("sent_ranked");

  const [
    moves,
    facts,
    decisions,
    slotRows,
    children,
    runners,
    posts,
    sentPosts,
  ] = await Promise.all([
    db.select().from(movesRanked).where(lte(movesRanked.rank, limit)),
    db.select().from(factsRanked).where(lte(factsRanked.rank, limit)),
    db.select().from(decisionsRanked).where(lte(decisionsRanked.rank, limit)),
    db.select().from(slotsRanked).where(lte(slotsRanked.rank, limit)),
    db.select().from(childrenRanked).where(lte(childrenRanked.rank, limit)),
    db.select().from(runnersRanked).where(lte(runnersRanked.rank, limit)),
    db.select().from(postsRanked).where(lte(postsRanked.rank, limit)),
    db.select().from(sentRanked).where(lte(sentRanked.rank, limit)),
  ]);

  const pending = new Map<string, Pending[]>();
  const truncated = new Set<string>();
  const push = (sessionId: string | null, p: Pending | null) => {
    if (!sessionId || !p) return;
    const list = pending.get(sessionId);
    if (list) list.push(p);
  };
  const keep = (r: { owner: string | null; rank: number }) => {
    if (!r.owner) return false;
    if (Number(r.rank) > perSource) {
      truncated.add(r.owner);
      return false;
    }
    return true;
  };

  for (const s of sessions) {
    const isAgent = Boolean(s.agentId) || s.origin === "agent";
    pending.set(s.id, [
      {
        event: {
          id: `session:${s.id}:start`,
          kind: "session_started",
          at: iso(s.startedAt ?? s.createdAt),
          refs: { sessionId: s.id },
          title: resolveSessionTitle(s) || "Session",
        },
        actorId: s.agentId ?? (isAgent ? null : s.userId),
        isAgent,
      },
    ]);
  }
  for (const r of moves) {
    if (keep(r)) push(r.owner, statusMovedEvent(r, { sessionId: r.owner }));
  }
  for (const r of facts) if (keep(r)) push(r.owner, devFactEvent(r));
  const decisionsBySession = new Map<string, typeof decisions>();
  for (const r of decisions) {
    if (!keep({ owner: r.sessionId, rank: r.rank })) continue;
    const list = decisionsBySession.get(r.sessionId!) ?? [];
    list.push(r);
    decisionsBySession.set(r.sessionId!, list);
  }
  for (const [sessionId, rows] of decisionsBySession) {
    for (const e of decisionEvents(rows, (p) => ({
      refs: { sessionId, proposalId: p.id },
    }))) {
      push(sessionId, e);
    }
  }
  for (const r of slotRows) {
    if (keep(r)) push(r.owner, slotEvent(r, r.owner));
  }
  for (const s of sessions) {
    // The stage ledger rides on the row: its newest `perSource` entries.
    const stages = readSessionStageHistory(s.stageHistory);
    if (stages.length > perSource) truncated.add(s.id);
    for (
      let index = Math.max(0, stages.length - perSource);
      index < stages.length;
      index++
    ) {
      const entry = stages[index]!;
      push(s.id, {
        event: {
          id: `stage:${s.id}:${index}`,
          kind: "stage_moved",
          at: iso(entry.enteredAt),
          refs: { sessionId: s.id },
          from: entry.fromStage ?? null,
          to: entry.stageKey,
          via: entry.via,
        },
        actorId: entry.actor || entry.userId,
        isAgent: Boolean(entry.actor) && entry.actor !== entry.userId,
      });
    }
  }
  for (const r of children) {
    if (!keep(r)) continue;
    push(r.owner, {
      event: {
        id: `link:${r.id}`,
        kind: "child_started",
        at: iso(r.createdAt),
        refs: { sessionId: r.childId },
        child: {
          id: r.childId,
          title:
            resolveSessionTitle({ title: r.childTitle, goal: r.childGoal }) ||
            "Session",
          status: r.childStatus,
        },
      },
      actorId: r.createdBy,
      isAgent: false,
    });
  }
  const ownerOfSession = new Map(sessions.map((s) => [s.id, s.userId]));
  for (const r of runners) {
    if (!keep(r)) continue;
    const runnerId = `${r.harness}:${r.conversationId}`;
    push(r.owner, {
      event: {
        id: `runner:${r.owner}:${r.clientKey}:${r.processKey}`,
        kind: "runner_seen",
        at: iso(r.firstSeenAt),
        refs: { sessionId: r.owner, runnerId },
        runner: {
          harness: r.harness,
          conversationId: r.conversationId,
          computer: r.processHost ?? null,
          model: r.model ?? null,
          provider: r.provider ?? null,
          state: r.state ?? null,
          lastSeenAt: iso(r.lastSeenAt),
        },
      },
      actorId: r.agentUserId ?? ownerOfSession.get(r.owner) ?? null,
      isAgent: Boolean(r.agentUserId),
      computerId: r.machineUserId,
    });
  }
  // A post joins each session of its room once, a sent one its sender.
  const posted = new Set<string>();
  const pushPost = (sessionId: string, r: PostRow) => {
    if (posted.has(`${sessionId}:${r.id}`)) return;
    posted.add(`${sessionId}:${r.id}`);
    push(sessionId, roomPostEvent(r, sessionId));
  };
  for (const r of posts) {
    const owners = sessionsOfRoom.get(r.owner) ?? [];
    if (Number(r.rank) > perSource) {
      for (const id of owners) truncated.add(id);
      continue;
    }
    for (const id of owners) pushPost(id, r);
  }
  for (const r of sentPosts) if (keep(r)) pushPost(r.owner, r);

  // Every actor of every session, named in ONE read.
  const ownerOf = new Map<string, string>();
  for (const [sessionId, list] of pending) {
    for (const p of list) ownerOf.set(p.event.id, sessionId);
  }
  const named = await finish([...pending.values()].flat(), actor.userId);
  const grouped = new Map<string, DevTimelineEvent[]>();
  for (const e of named) {
    const sessionId = ownerOf.get(e.id)!;
    const list = grouped.get(sessionId) ?? [];
    list.push(e);
    grouped.set(sessionId, list);
  }
  for (const s of sessions) {
    out.set(s.id, {
      title: resolveSessionTitle(s) || "Session",
      events: grouped.get(s.id) ?? [],
      truncated: truncated.has(s.id),
    });
  }
  return out;
}

async function readSessionTimeline(
  sessionId: string,
  actor: TimelineReader
): Promise<TimelineWire | null> {
  const read = (await readSessionTimelines([sessionId], actor)).get(sessionId);
  if (!read) return null;
  return {
    subject: { kind: "session", id: sessionId, title: read.title },
    events: read.events,
    truncated: read.truncated,
  };
}

async function readPullRequestTimeline(
  ref: PullRequestRef,
  actor: TimelineReader
): Promise<TimelineWire> {
  const cap = TIMELINE_SOURCE_CAP;
  const visible = eventVisibleWhere({
    userId: actor.userId,
    roster: false,
    lens: actor.lens,
  });
  const repoIs = drizzleSql`lower(${events.data}->>'repo') = ${ref.repo.toLowerCase()}`;
  const select = {
    id: events.id,
    type: events.type,
    timestamp: events.timestamp,
    data: events.data,
  };
  const prRows = await db
    .select(select)
    .from(events)
    .where(
      and(
        inArray(events.type, Object.keys(PR_FACT_KIND)),
        repoIs,
        drizzleSql`${events.data}->>'number' = ${String(ref.number)}`,
        visible
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(cap + 1);
  // A run is the PR's when it names it, or ran on a head a PR fact named.
  const heads = prRows.flatMap((r) => {
    const d = r.data as { sha?: unknown; headSha?: unknown } | null;
    return [d?.sha, d?.headSha].filter(
      (s): s is string => typeof s === "string" && s.length >= 7
    );
  });
  const ciRows = await db
    .select(select)
    .from(events)
    .where(
      and(
        eq(events.type, DEV_LOOP_EVENT_TYPES.ciFinished),
        repoIs,
        or(
          drizzleSql`${events.data}->>'pr' = ${String(ref.number)}`,
          ...(heads.length
            ? [
                inArray(drizzleSql`lower(left(${events.data}->>'sha', 7))`, [
                  ...new Set(heads.map((s) => s.slice(0, 7).toLowerCase())),
                ]),
              ]
            : [])
        ),
        visible
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(cap + 1);
  const out: Pending[] = [];
  for (const r of prRows.slice(0, cap)) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (
      typeof d.repo !== "string" ||
      !samePullRequest(ref, { repo: d.repo, number: ref.number })
    )
      continue;
    const e = devFactEvent(r);
    if (e) out.push(e);
  }
  for (const r of ciRows.slice(0, cap)) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const sha = typeof d.sha === "string" ? d.sha : "";
    // The SQL matched 7 characters; the fold's rule is the whole prefix.
    if (d.pr !== ref.number && !heads.some((h) => sameCommit(h, sha))) continue;
    const e = devFactEvent(r);
    if (e) out.push(e);
  }
  return {
    subject: {
      kind: "pull_request",
      repo: ref.repo,
      number: ref.number,
      url: pullRequestUrl(ref),
    },
    events: await finish(out, actor.userId),
    truncated: prRows.length > cap || ciRows.length > cap,
  };
}
