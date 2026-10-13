/**
 * WHO IS ON A THING — the "being worked" mark on a pipeline card (surfaces
 * W1.3, design C), read for a whole board in ONE batch.
 *
 * A thing is being worked when an OPEN session is on it — the same "on" as
 * the session list's subject narrow (`session-subject-where.ts`):
 *   - a session whose SUBJECT is the thing (`subject_entity_id`), or
 *   - a WORKER session targeting it whose target has no result yet and whose
 *     session is still in flight (`worker_target` link, the stage worker's
 *     own "in flight" rule `WORKER_IN_FLIGHT_SESSION_STATUSES`).
 *
 * `kind` = `worker` when an automation started the session (its top-level
 * `metadata.automationId` stamp — how every worker session is marked), else
 * `session`. `live` = working RIGHT NOW by THE rule (`isSessionWorkingNow`,
 * D1) over the one batched liveness read — the same answer the rail's
 * "Working now" gives. Live first, then most recently moved; capped per thing.
 *
 * Floor: `sessionReadableWhere` — a card never names a session its viewer
 * cannot open. A failed liveness read THROWS (never "quiet").
 *
 * SESSION-KIND-LENS-EXEMPT: returns `{sessionId, kind, live}` MARKS per thing, never a session row; triage is irrelevant to "is someone on it" and the worker/session kind is derived here from the automation stamp.
 */
import {
  db,
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  drizzleSql,
  focusSessions,
  links,
  WORKER_IN_FLIGHT_SESSION_STATUSES,
  WORKER_TARGET_LINK_ROLE,
} from "@synap/database";
import {
  isSessionWorkingNow,
  SESSION_WORKING_WINDOW_MS,
} from "@synap-core/types/run-activity";
import { MOVING_UNATTACHED_CAP } from "@synap-core/types/lens";
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { sessionKindWhere } from "../focus-sessions/session-kind.js";
import { notTriagePendingWhere } from "../focus-sessions/triage.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { loadSessionLiveness } from "../runs/session-liveness.js";

/** Sessions shown per thing — a card has room for a mark, not a list. */
export const WORKED_BY_CAP = 2;

export interface WorkedBy {
  sessionId: string;
  kind: "session" | "worker";
  live: boolean;
}

/**
 * ONE open session ON a thing — a row of the predicate above, with its
 * liveness resolved. `thingId` is the entity it is on (its subject, or a
 * worker's target). A session on several things appears once per thing.
 */
export interface OpenWorkRow {
  thingId: string;
  sessionId: string;
  status: string;
  title: string | null;
  goal: string | null;
  agentIds: string[];
  expectedOutputs: unknown;
  /** The session's `metadata.automationId` — set on every worker session. */
  automationId: string | null;
  startedAt: Date;
  updatedAt: Date;
  /** Working RIGHT NOW (`isSessionWorkingNow`). */
  live: boolean;
}

/**
 * The open work on things, per thing (most recently moved first): over
 * `entityIds`, or — `null` — over EVERY thing the reader has open work on
 * (the homes' "being worked" and "Moving now" reads; bounded by the reader's
 * open sessions, never by the number of things). Floored by
 * `sessionReadableWhere`; a failed liveness read THROWS.
 */
export async function loadOpenWork(
  reader: { userId: string; roster: boolean },
  entityIds: readonly string[] | null
): Promise<Map<string, OpenWorkRow[]>> {
  const out = new Map<string, OpenWorkRow[]>();
  const ids = entityIds === null ? null : [...new Set(entityIds)];
  if (ids !== null && ids.length === 0) return out;

  const cols = {
    id: focusSessions.id,
    status: focusSessions.status,
    title: focusSessions.title,
    goal: focusSessions.goal,
    agentIds: focusSessions.agentIds,
    channelId: focusSessions.channelId,
    expectedOutputs: focusSessions.expectedOutputs,
    startedAt: focusSessions.startedAt,
    updatedAt: focusSessions.updatedAt,
    automationId: drizzleSql<
      string | null
    >`${focusSessions.metadata}->>'automationId'`,
  };
  const floor = sessionReadableWhere(reader);
  const [bySubject, byTarget] = await Promise.all([
    db
      .select({
        ...cols,
        thingId: drizzleSql<string>`${focusSessions.subjectEntityId}::text`,
      })
      .from(focusSessions)
      .where(
        and(
          floor,
          ids === null
            ? isNotNull(focusSessions.subjectEntityId)
            : inArray(focusSessions.subjectEntityId, ids),
          inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .orderBy(desc(focusSessions.updatedAt)),
    db
      .select({ ...cols, thingId: links.toId })
      .from(links)
      // `links.from_id` is text (polymorphic), `focus_sessions.id` a uuid.
      .innerJoin(
        focusSessions,
        drizzleSql`${links.fromId} = ${focusSessions.id}::text`
      )
      .where(
        and(
          floor,
          drizzleSql`${links.fromType} = 'session'`,
          drizzleSql`${links.toType} = 'entity'`,
          drizzleSql`${links.linkType} = 'targets'`,
          drizzleSql`${links.metadata}->>'role' = ${WORKER_TARGET_LINK_ROLE}`,
          drizzleSql`${links.metadata}->>'result' IS NULL`,
          ...(ids === null ? [] : [inArray(links.toId, ids)]),
          inArray(focusSessions.status, [...WORKER_IN_FLIGHT_SESSION_STATUSES])
        )
      )
      .orderBy(desc(focusSessions.updatedAt)),
  ]);

  const rows = [...bySubject, ...byTarget];
  const sessions = [...new Map(rows.map((r) => [r.id, r])).values()];
  const now = Date.now();
  const live = await loadSessionLiveness(reader, sessions, {
    since: new Date(now - SESSION_WORKING_WINDOW_MS),
  });
  if (sessions.some((s) => live.get(s.id) === null)) {
    throw new Error("session liveness read failed");
  }

  const perThing = new Map<string, Map<string, (typeof rows)[number]>>();
  for (const r of rows) {
    let m = perThing.get(r.thingId);
    if (!m) perThing.set(r.thingId, (m = new Map()));
    m.set(r.id, r);
  }
  for (const [thingId, m] of perThing) {
    out.set(
      thingId,
      [...m.values()]
        .map((r) => ({
          thingId,
          sessionId: r.id,
          status: r.status as string,
          title: r.title ?? null,
          goal: r.goal ?? null,
          agentIds: r.agentIds ?? [],
          expectedOutputs: r.expectedOutputs,
          automationId: r.automationId ?? null,
          startedAt: new Date(r.startedAt),
          updatedAt: new Date(r.updatedAt),
          live: isSessionWorkingNow(live.get(r.id), now),
        }))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    );
  }
  return out;
}

export async function loadWorkedBy(
  reader: { userId: string; roster: boolean },
  entityIds: readonly string[]
): Promise<Map<string, WorkedBy[]>> {
  const out = new Map<string, WorkedBy[]>();
  const work = await loadOpenWork(reader, entityIds);
  for (const [thingId, rows] of work) {
    const marks = rows
      .map((r) => ({
        sessionId: r.sessionId,
        kind: r.automationId ? ("worker" as const) : ("session" as const),
        live: r.live,
        at: r.updatedAt.getTime(),
      }))
      .sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at)
      .slice(0, WORKED_BY_CAP)
      .map(({ at: _at, ...mark }) => mark);
    out.set(thingId, marks);
  }
  return out;
}

/** Subjectless sessions shown in Moving now — a nudge, not a session list (the shared cap). */
export const UNATTACHED_CAP = MOVING_UNATTACHED_CAP;

/** An open session ON NO thing (`loadUnattachedWork`), with its own space. */
export type UnattachedWorkRow = Omit<OpenWorkRow, "thingId"> & {
  /** The SESSION's space (`focus_sessions.workspace_id`); null = none. */
  workspaceId: string | null;
};

/**
 * The open WORK sessions on no thing (homes A7): open, no subject, and no
 * worker target (the other "on" of `loadOpenWork`) — the work Moving now
 * cannot place under a thing, so it shows it as "No thing yet · attach one".
 * The `work` kind only (never a run or a receipt) and never an undecided
 * agent draft (triage — the same rule needs-you uses). Floored by
 * `sessionReadableWhere`, narrowed by the session's own space / project,
 * most recently moved first, capped at `limit`. A failed liveness read
 * THROWS.
 */
export async function loadUnattachedWork(
  reader: { userId: string; roster: boolean },
  opts: { workspaceId?: string; projectId?: string; limit?: number } = {}
): Promise<UnattachedWorkRow[]> {
  const rows = await db
    .select({
      id: focusSessions.id,
      status: focusSessions.status,
      title: focusSessions.title,
      goal: focusSessions.goal,
      agentIds: focusSessions.agentIds,
      channelId: focusSessions.channelId,
      expectedOutputs: focusSessions.expectedOutputs,
      startedAt: focusSessions.startedAt,
      updatedAt: focusSessions.updatedAt,
      workspaceId: focusSessions.workspaceId,
      automationId: drizzleSql<
        string | null
      >`${focusSessions.metadata}->>'automationId'`,
    })
    .from(focusSessions)
    .where(
      and(
        sessionReadableWhere(reader),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        isNull(focusSessions.subjectEntityId),
        sessionKindWhere("work"),
        notTriagePendingWhere(),
        drizzleSql`NOT EXISTS (
          SELECT 1 FROM ${links}
          WHERE ${links.fromType} = 'session'
            AND ${links.fromId} = ${focusSessions.id}::text
            AND ${links.toType} = 'entity'
            AND ${links.metadata}->>'role' = ${WORKER_TARGET_LINK_ROLE}
        )`,
        ...(opts.workspaceId
          ? [eq(focusSessions.workspaceId, opts.workspaceId)]
          : []),
        ...(opts.projectId ? [eq(focusSessions.projectId, opts.projectId)] : [])
      )
    )
    .orderBy(desc(focusSessions.updatedAt))
    .limit(opts.limit ?? UNATTACHED_CAP);
  if (rows.length === 0) return [];

  const now = Date.now();
  const live = await loadSessionLiveness(reader, rows, {
    since: new Date(now - SESSION_WORKING_WINDOW_MS),
  });
  if (rows.some((s) => live.get(s.id) === null)) {
    throw new Error("session liveness read failed");
  }
  return rows.map((r) => ({
    sessionId: r.id,
    status: r.status as string,
    title: r.title ?? null,
    goal: r.goal ?? null,
    agentIds: r.agentIds ?? [],
    expectedOutputs: r.expectedOutputs,
    automationId: r.automationId ?? null,
    startedAt: new Date(r.startedAt),
    updatedAt: new Date(r.updatedAt),
    live: isSessionWorkingNow(live.get(r.id), now),
    workspaceId: r.workspaceId ?? null,
  }));
}
