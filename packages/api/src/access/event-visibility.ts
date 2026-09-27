/**
 * THE event read rule — who may see a row of the `events` log.
 *
 * An event is visible to a reader when BOTH floors hold:
 *
 *  1. WORKSPACE floor. The event's workspace is
 *     `COALESCE(workspace_id, data->>'workspaceId')` (the column since 0223, the
 *     JSONB for older rows — the same resolution every event reader uses).
 *       - a workspace event follows `userVisibleWhere`: the reader is a member
 *         or owner of that workspace, or it is pod-visible;
 *       - a NULL-workspace event is PERSONAL (`ownerPrivate`): only its own
 *         `user_id` sees it. `userVisibleWhere`'s NULL branch is owner-blind,
 *         so it is never reached here.
 *  2. SESSION floor (decision D1). An event whose subject is a focus session,
 *     or that was recorded inside one (`session_id`), is visible only when the
 *     reader may read that session — `sessionReadableWhere`, the one session
 *     read rule.
 *
 * There is no admin branch. Owning a workspace grants that workspace's events,
 * never the pod's.
 *
 * The workspace is compared as TEXT against the visible workspace ids: the
 * JSONB fallback is free text, and a `::uuid` cast of a malformed value would
 * make the whole read throw.
 */

import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { events, focusSessions, workspaces } from "@synap/database/schema";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { requireUserId } from "../utils/user-scoped.js";
import { rosterReadFor, sessionReadableWhere } from "./session-visibility.js";

type WorkspaceLens = string | string[] | null | undefined;

/** Subqueries only — never executed on their own. */
const qb = new QueryBuilder();

/** The event's workspace: the 0223 column, else the JSONB of older rows. */
export const eventWorkspaceExpr = sql<
  string | null
>`COALESCE(${events.workspaceId}, ${events.data}->>'workspaceId')`;

export interface EventReader {
  userId: string;
  /**
   * Honour the session roster branch. A HUMAN door does (`rosterReadFor(ctx)`);
   * an agent key reads sessions owner-only.
   */
  roster: boolean;
  /**
   * Workspace lens — only narrows. `undefined` = every event the reader may
   * see; `null` = personal (NULL-workspace) events only; an id or ids = those
   * workspaces only.
   */
  lens?: WorkspaceLens;
}

export function eventVisibleWhere(reader: EventReader): SQL {
  const { userId, roster, lens } = reader;
  const ws = eventWorkspaceExpr;

  const visibleWorkspaceIds = qb
    .select({ id: sql<string>`${workspaces.id}::text`.as("id") })
    .from(workspaces)
    .where(userVisibleWhere(workspaces.id, userId));
  const workspaceFloor = or(
    and(isNull(ws), eq(events.userId, userId)),
    inArray(ws, visibleWorkspaceIds)
  )!;

  const readableSessionIds = qb
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(sessionReadableWhere({ userId, roster }));
  const readableSessionIdsText = qb
    .select({ id: sql<string>`${focusSessions.id}::text`.as("id") })
    .from(focusSessions)
    .where(sessionReadableWhere({ userId, roster }));
  // `IS DISTINCT FROM`, not `<>`: a NULL subject type is not a session event.
  const sessionFloor = and(
    or(
      sql`${events.subjectType} IS DISTINCT FROM 'focus_session'`,
      inArray(events.subjectId, readableSessionIdsText)
    ),
    or(isNull(events.sessionId), inArray(events.sessionId, readableSessionIds))
  )!;

  const floor = and(workspaceFloor, sessionFloor)!;
  if (lens === undefined || (Array.isArray(lens) && lens.length === 0)) {
    return floor;
  }
  if (lens === null) return and(isNull(ws), floor)!;
  return and(Array.isArray(lens) ? inArray(ws, lens) : eq(ws, lens), floor)!;
}

/**
 * The floor for an event DOOR (tRPC / Hub), from its request context: the
 * caller's own user, with the session roster honoured only for a human door.
 */
export function eventVisibleWhereFor(ctx: {
  userId?: string | null;
  agentUserId?: string | null;
  isHubProtocol?: boolean;
}): SQL {
  return eventVisibleWhere({
    userId: requireUserId(ctx.userId),
    roster: rosterReadFor(ctx),
  });
}
