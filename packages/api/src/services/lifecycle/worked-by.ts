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
  inArray,
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
import { OPEN_SESSION_STATUSES } from "../focus-sessions/session-statuses.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { loadSessionLiveness } from "../runs/session-liveness.js";

/** Sessions shown per thing — a card has room for a mark, not a list. */
export const WORKED_BY_CAP = 2;

export interface WorkedBy {
  sessionId: string;
  kind: "session" | "worker";
  live: boolean;
}

export async function loadWorkedBy(
  reader: { userId: string; roster: boolean },
  entityIds: readonly string[]
): Promise<Map<string, WorkedBy[]>> {
  const out = new Map<string, WorkedBy[]>();
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return out;

  const cols = {
    id: focusSessions.id,
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
          inArray(focusSessions.subjectEntityId, ids),
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
          inArray(links.toId, ids),
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
    const marks = [...m.values()]
      .map((r) => ({
        sessionId: r.id,
        kind: r.automationId ? ("worker" as const) : ("session" as const),
        live: isSessionWorkingNow(live.get(r.id), now),
        at: new Date(r.updatedAt).getTime(),
      }))
      .sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at)
      .slice(0, WORKED_BY_CAP)
      .map(({ at: _at, ...mark }) => mark);
    out.set(thingId, marks);
  }
  return out;
}
