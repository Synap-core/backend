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
 *                     in it (pending; decided by a PERSON), as the goal history.
 *   pull_request  its `dev.pr_*` facts, and the CI runs that name it or ran on
 *                 a head sha one of them named (the PR fold's own rule).
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
  db,
  desc,
  drizzleSql,
  eq,
  events,
  focusSessions,
  inArray,
  isNotNull,
  lifecycleTransitionOutbox,
  or,
  proposals,
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
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type { TransitionBase } from "@synap-core/types/lifecycle";
import {
  timelineRecordedAt,
  type DevTimelineEvent,
  type TimelineWire,
} from "@synap-core/types/units";

import { decisionEvents } from "../activity/decision-events.js";
import { eventVisibleWhere } from "../../access/event-visibility.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { activityActorOf, loadActorRows } from "../activity/activity-actors.js";
import {
  sessionDevFactWhere,
  sessionPullRequestRefs,
} from "../focus-sessions/session-changes.js";
import { UUID_RE } from "../focus-sessions/session-metadata.js";
import { readTrackHistory } from "../tracks/track-history.js";
import type { TrackActor } from "../tracks/tracks-service.js";

/** Rows read per source. Hitting it sets `truncated` — older rows exist. */
export const TIMELINE_SOURCE_CAP = 500;

export type TimelineSubject =
  | { kind: "goal"; id: string }
  | { kind: "session"; id: string }
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
    return UUID_RE.test(query.goalId)
      ? { ok: true, subject: { kind: "goal", id: query.goalId } }
      : { ok: false, error: "goalId must be a UUID." };
  }
  if (query.sessionId) {
    return UUID_RE.test(query.sessionId)
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

const DECISION_STATUSES = [
  "approved",
  "rejected",
  "reverted",
  "approval_failed",
] as const;

/** An event before its actor is named (named in ONE batch at the end). */
type Unnamed<E> = E extends unknown
  ? Omit<E, "actor"> & { actor?: ActivityActor }
  : never;
interface Pending {
  event: Unnamed<DevTimelineEvent>;
  actorId: string | null;
  isAgent: boolean;
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
  const rows = await loadActorRows(out.map((p) => p.actorId));
  const named = out.map(
    (p) =>
      ({
        ...p.event,
        actor:
          p.event.actor ??
          activityActorOf(
            p.actorId,
            p.actorId ? rows.get(p.actorId) : undefined,
            viewer,
            p.isAgent
          ),
      }) as DevTimelineEvent
  );
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
  return readPullRequestTimeline(subject.ref, actor);
}

async function readSessionTimeline(
  sessionId: string,
  actor: TimelineReader
): Promise<TimelineWire | null> {
  const [session] = await db
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
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.id, sessionId),
        sessionReadableWhere({ userId: actor.userId, lens: actor.lens })
      )
    )
    .limit(1);
  if (!session) return null;
  const cap = TIMELINE_SOURCE_CAP;
  const outbox = lifecycleTransitionOutbox;

  const [moves, facts, decisions] = await Promise.all([
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
          drizzleSql`coalesce(${outbox.transition}->>'subjectId', ${outbox.transition}->>'entityId') = ${session.id}`,
          drizzleSql`${outbox.transition}->>'subjectType' = 'focus_session'`
        )
      )
      .orderBy(desc(outbox.createdAt))
      .limit(cap + 1),
    db
      .select({
        id: events.id,
        type: events.type,
        timestamp: events.timestamp,
        data: events.data,
      })
      .from(events)
      .where(
        and(
          inArray(events.type, DEV_FACT_TYPES),
          sessionDevFactWhere(
            session.id,
            sessionPullRequestRefs(session.expectedOutputs)
          ),
          eventVisibleWhere({
            userId: actor.userId,
            roster: false,
            lens: actor.lens,
          })
        )
      )
      .orderBy(desc(events.timestamp))
      .limit(cap + 1),
    db
      .select({
        id: proposals.id,
        status: proposals.status,
        createdAt: proposals.createdAt,
        reviewedAt: proposals.reviewedAt,
        reviewedBy: proposals.reviewedBy,
        agentUserId: proposals.agentUserId,
        authorId: drizzleSql<
          string | null
        >`coalesce(${proposals.agentUserId}, ${proposals.proposedByUserId}, ${proposals.createdBy})`,
        summary: drizzleSql<
          string | null
        >`coalesce(nullif(${proposals.data}->>'_summary', ''), nullif(${proposals.data}->>'summary', ''))`,
        rejectionReason: proposals.rejectionReason,
        comments: proposals.comments,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.sessionId, session.id),
          or(
            eq(proposals.status, "pending"),
            and(
              inArray(proposals.status, [...DECISION_STATUSES]),
              isNotNull(proposals.reviewedBy),
              isNotNull(proposals.reviewedAt)
            )
          )
        )
      )
      .orderBy(desc(proposals.createdAt))
      .limit(cap + 1),
  ]);
  const truncated =
    moves.length > cap || facts.length > cap || decisions.length > cap;

  const title = resolveSessionTitle(session) || "Session";
  const isAgent = Boolean(session.agentId) || session.origin === "agent";
  const out: Pending[] = [
    {
      event: {
        id: `session:${session.id}:start`,
        kind: "session_started",
        at: iso(session.startedAt ?? session.createdAt),
        refs: { sessionId: session.id },
        title,
      },
      actorId: session.agentId ?? (isAgent ? null : session.userId),
      isAgent,
    },
  ];

  for (const r of moves.slice(0, cap)) {
    const t = (
      typeof r.transition === "string" ? JSON.parse(r.transition) : r.transition
    ) as TransitionBase;
    if (typeof t?.to !== "string") continue;
    // A row owed before moves stamped their times (W4) has only its own.
    const recordedAt = t.recordedAt ?? iso(r.createdAt);
    const at = iso(t.occurredAt ?? recordedAt);
    out.push({
      event: {
        id: `transition:${r.id}`,
        kind: "status_moved",
        at,
        ...timelineRecordedAt(at, recordedAt),
        refs: { sessionId: session.id },
        from: t.from ?? null,
        to: t.to,
        category: t.category,
        reason: t.reason ?? null,
        hold: t.hold ?? null,
        ...(t.actorKind === "system" ? { actor: SYSTEM } : {}),
      },
      actorId: t.actorKind === "agent" ? t.agentUserId : t.userId,
      isAgent: t.actorKind === "agent",
    });
  }

  for (const r of facts.slice(0, cap)) {
    const e = devFactEvent(r);
    if (e) out.push(e);
  }

  out.push(
    ...decisionEvents(decisions.slice(0, cap), (p) => ({
      refs: { sessionId: session.id, proposalId: p.id },
    }))
  );

  return {
    subject: { kind: "session", id: session.id, title },
    events: await finish(out, actor.userId),
    truncated,
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
