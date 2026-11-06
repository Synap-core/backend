/**
 * THINGS LEFT BEHIND (plan b38e5e64 §4 item 6, §5.5): a thing whose work
 * ENDED while it stayed open or active, with the session that ended.
 *
 * A thing is left behind when ALL of:
 *  - a session that ENDED (`TERMINAL_SESSION_STATUSES`: closed, cancelled,
 *    failed) worked on it: its SUBJECT, or one of its TARGETS (`session
 *    --targets--> entity`, role `WORKER_TARGET_LINK_ROLE`, whatever the
 *    target's result: a target skipped at the close is exactly a thing left
 *    behind) — the two shapes of "works on" (`session-targets.ts`);
 *  - its status is still in an `open` or `active` category: the kind's own
 *    (`entities.status_category`), else the most recently moved role facet the
 *    caller can see (`entity_facets.status_category`, a role subject's status).
 *    `paused` is not left behind: a pause names what it waits on;
 *  - NO session that has not ended is on it (subject, or a target with no
 *    result yet). This half is NOT floored by the caller's visibility: a
 *    thing someone else is working is not left behind, and the read only
 *    ever drops it (it never names that session).
 *
 * Each thing carries the session that ended LAST on it among the ones the
 * caller may read (`sessionReadableWhere`, the floor `loadOpenWork` uses);
 * the thing itself goes through the listing floors of the neighbouring
 * lifecycle reads (`kindVisibilityConditions` for the thing,
 * `roleVisibilityConditions` for a facet), so a thing or facet the caller
 * cannot read is never listed. Receipts (bookkeeping sessions an agent's
 * writes are filed under) never leave anything behind (`notReceiptWhere`).
 *
 * Bounded: newest-ended first, `limit` rows plus the whole population's
 * `total`. A failed read THROWS: "nothing was left behind" is a claim this
 * read must earn; each door decides how it reports a failure (never as an
 * empty list).
 *
 * SESSION-KIND-LENS-EXEMPT: returns things, each with ONE ended-session MARK
 * (id, label, terminal status, when), never a page of session rows.
 */
import { db, and, drizzleSql, WORKER_TARGET_LINK_ROLE } from "@synap/database";
import { entities, focusSessions, links } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import {
  TERMINAL_SESSION_STATUSES,
  resolveSessionTitle,
  type TerminalSessionStatus,
} from "@synap-core/types/focus-sessions";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { notReceiptWhere } from "../focus-sessions/session-kind.js";
import { rowsOf } from "../../utils/execute-rows.js";
import {
  kindVisibilityConditions,
  roleVisibilityConditions,
} from "./status-groups.js";

/** Rows a door lists; `total` is the whole population. */
export const LEFT_BEHIND_CAP = 20;

/** The lifecycle categories a thing still waits in. */
const STILL_OPEN_CATEGORIES = ["open", "active"] as const;

export interface LeftBehindItem {
  entityId: string;
  title: string | null;
  /** The kind's slug, or the role's when the status is a facet's. */
  profileSlug: string | null;
  /** That identity's space: the thing's, or the facet's. */
  workspaceId: string | null;
  status: string | null;
  category: (typeof STILL_OPEN_CATEGORIES)[number];
  /** The session that ended last on it (among the ones the caller may read). */
  endedSession: {
    id: string;
    label: string;
    status: TerminalSessionStatus;
    /** When it ended (`closed_at`; its last update for a row with none). */
    closedAt: string;
  };
}

export interface LeftBehindRead {
  /** The whole population (every row the floors and the scope keep). */
  total: number;
  items: LeftBehindItem[];
}

const sqlList = (values: readonly string[]): SQL =>
  drizzleSql.join(
    values.map((v) => drizzleSql`${v}`),
    drizzleSql`, `
  );

interface Row {
  entity_id: string;
  title: string | null;
  profile_slug: string | null;
  workspace_id: string | null;
  status: string | null;
  category: string;
  session_id: string;
  session_title: string | null;
  session_goal: string | null;
  session_status: string;
  ended_at: Date | string;
  total: number | string;
}

/**
 * The things left behind, newest-ended first. `sessionWhere` narrows the
 * ENDED sessions (loose ends: the calling agent's own); `workspaceId`
 * narrows to the identity's space, `projectId` to the project lens (the
 * visibility conditions carry it, as they do for `readMoving`).
 */
export async function readLeftBehind(
  reader: { userId: string; roster: boolean },
  opts: {
    limit: number;
    workspaceId?: string;
    projectId?: string;
    sessionWhere?: SQL;
  }
): Promise<LeftBehindRead> {
  const limit = Math.max(1, Math.min(opts.limit, LEFT_BEHIND_CAP));
  const terminal = sqlList(TERMINAL_SESSION_STATUSES);
  const stillOpen = sqlList(STILL_OPEN_CATEGORIES);
  const endedFloor = and(
    sessionReadableWhere(reader),
    drizzleSql`${focusSessions.status} IN (${terminal})`,
    notReceiptWhere(),
    ...(opts.sessionWhere ? [opts.sessionWhere] : [])
  ) as SQL;
  const kindConds = kindVisibilityConditions({
    userId: reader.userId,
    lensWorkspaceId: undefined,
    explicitWorkspace: false,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    podScopeKind: false,
  });
  const roleConds = await roleVisibilityConditions({
    userId: reader.userId,
    lensWorkspaceId: undefined,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });

  const res = await db.execute(drizzleSql`
    WITH ended AS (
      SELECT DISTINCT ON (u.thing_id) u.*
        FROM (
          SELECT ${focusSessions.subjectEntityId}::text AS thing_id,
                 ${focusSessions.id} AS session_id,
                 ${focusSessions.title} AS session_title,
                 ${focusSessions.goal} AS session_goal,
                 ${focusSessions.status} AS session_status,
                 COALESCE(${focusSessions.closedAt}, ${focusSessions.updatedAt}) AS ended_at
            FROM ${focusSessions}
           WHERE ${focusSessions.subjectEntityId} IS NOT NULL
             AND ${endedFloor}
          UNION ALL
          SELECT ${links.toId} AS thing_id,
                 ${focusSessions.id} AS session_id,
                 ${focusSessions.title} AS session_title,
                 ${focusSessions.goal} AS session_goal,
                 ${focusSessions.status} AS session_status,
                 COALESCE(${focusSessions.closedAt}, ${focusSessions.updatedAt}) AS ended_at
            FROM ${links}
            JOIN ${focusSessions}
              ON ${links.fromId} = ${focusSessions.id}::text
           WHERE ${links.fromType} = 'session'
             AND ${links.toType} = 'entity'
             AND ${links.linkType} = 'targets'
             AND ${links.metadata}->>'role' = ${WORKER_TARGET_LINK_ROLE}
             AND ${endedFloor}
        ) u
       ORDER BY u.thing_id, u.ended_at DESC, u.session_id
    ),
    left_behind AS (
      SELECT ${entities.id}::text AS entity_id,
             ${entities.title} AS title,
             CASE WHEN ${entities.statusCategory} IN (${stillOpen})
                  THEN COALESCE(
                    (SELECT kp.slug FROM profiles kp WHERE kp.id = ${entities.profileId}),
                    ${entities.type})
                  ELSE f.slug END AS profile_slug,
             CASE WHEN ${entities.statusCategory} IN (${stillOpen})
                  THEN ${entities.workspaceId}::text
                  ELSE f.workspace_id END AS workspace_id,
             CASE WHEN ${entities.statusCategory} IN (${stillOpen})
                  THEN ${entities.status}
                  ELSE f.status END AS status,
             CASE WHEN ${entities.statusCategory} IN (${stillOpen})
                  THEN ${entities.statusCategory}
                  ELSE f.category END AS category,
             ended.session_id, ended.session_title, ended.session_goal,
             ended.session_status, ended.ended_at
        FROM ended
        JOIN ${entities} ON ${entities.id}::text = ended.thing_id
        LEFT JOIN LATERAL (
          SELECT profiles.slug AS slug,
                 entity_facets.workspace_id::text AS workspace_id,
                 entity_facets.status AS status,
                 entity_facets.status_category AS category
            FROM entity_facets
            JOIN profiles ON profiles.id = entity_facets.profile_id
           WHERE entity_facets.entity_id = ${entities.id}
             AND profiles.profile_kind = 'role'
             AND entity_facets.deleted_at IS NULL
             AND entity_facets.status_category IN (${stillOpen})
             AND ${and(...roleConds) ?? drizzleSql`TRUE`}
           ORDER BY entity_facets.updated_at DESC NULLS LAST
           LIMIT 1
        ) f ON TRUE
       WHERE ${entities.deletedAt} IS NULL
         AND ${and(...kindConds) ?? drizzleSql`TRUE`}
         AND NOT EXISTS (
           SELECT 1 FROM focus_sessions live
            WHERE live.subject_entity_id = ${entities.id}
              AND live.status NOT IN (${terminal})
         )
         AND NOT EXISTS (
           SELECT 1 FROM links lt
             JOIN focus_sessions live ON lt.from_id = live.id::text
            WHERE lt.from_type = 'session'
              AND lt.to_type = 'entity'
              AND lt.link_type = 'targets'
              AND lt.to_id = ${entities.id}::text
              AND lt.metadata->>'role' = ${WORKER_TARGET_LINK_ROLE}
              AND lt.metadata->>'result' IS NULL
              AND live.status NOT IN (${terminal})
         )
    )
    SELECT lb.*, count(*) OVER () AS total
      FROM left_behind lb
     WHERE lb.category IN (${stillOpen})
       ${opts.workspaceId ? drizzleSql`AND lb.workspace_id = ${opts.workspaceId}` : drizzleSql``}
     ORDER BY lb.ended_at DESC, lb.entity_id
     LIMIT ${limit}
  `);
  const rows = rowsOf<Row>(res);
  return {
    total: rows.length === 0 ? 0 : Number(rows[0]!.total),
    items: rows.map((r) => ({
      entityId: r.entity_id,
      title: r.title ?? null,
      profileSlug: r.profile_slug ?? null,
      workspaceId: r.workspace_id ?? null,
      status: r.status ?? null,
      category: r.category as LeftBehindItem["category"],
      endedSession: {
        id: r.session_id,
        label: resolveSessionTitle({
          title: r.session_title,
          goal: r.session_goal,
        }),
        status: r.session_status as TerminalSessionStatus,
        closedAt: new Date(r.ended_at).toISOString(),
      },
    })),
  };
}
