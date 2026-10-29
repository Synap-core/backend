/**
 * FILING A ROOT CARRIES ITS OPEN SUB-SESSIONS (structural plan S5, founder Q7).
 *
 * A sub-session is born in its parent's project (the ladder's parent rung) and
 * goal (`create-session.ts`), but filing happens later, at the root: 101 of 141
 * open work sessions had no project on 29 Oct, hanging under 23 unfiled roots.
 * So a filing into a project or a goal also files the open sub-sessions that
 * FOLLOW the session being filed, in the SAME governed write: one receipt (or
 * one proposal) for the batch, and one Undo that restores every row.
 *
 * A sub-session FOLLOWS when it still sits where the filed session sits before
 * the filing (same space, project and goal). One placed elsewhere stays there,
 * and so does everything under it. A closed one is walked through (its open
 * children still follow) but never moved. Never an unfile, never a space move:
 * the caller only asks for a filing into a project or a goal.
 *
 * Lineage is the `spawned_from` edge (child → parent, same owner by its one
 * producer, `session-spawn.ts`); this walks it downward, owner-floored again.
 * It writes only the filing columns — never a status, never the parent.
 */
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  focusSessions,
  links,
  type Column,
} from "@synap/database";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import {
  readSessionUndoSnapshot,
  stampSessionUpdate,
} from "../proposals/stamp-materialized.js";

/** How deep, and how many sessions, one filing walks. */
const TREE_MAX_DEPTH = 10;
const TREE_MAX_SESSIONS = 200;

/** Where a session sits: what a sub-session must share to follow it. */
export interface SessionPlacement {
  workspaceId: string | null;
  projectId: string | null;
  trackId: string | null;
}

/** The filing columns a root's filing wrote, applied to what follows it. */
export type SessionTreeFilingSet = {
  projectId?: string | null;
  trackId?: string | null;
  trackStage?: string | null;
};

const samePlacement = (a: SessionPlacement, b: SessionPlacement): boolean =>
  (a.workspaceId ?? null) === (b.workspaceId ?? null) &&
  (a.projectId ?? null) === (b.projectId ?? null) &&
  (a.trackId ?? null) === (b.trackId ?? null);

const isOpen = (status: string): boolean =>
  (OPEN_SESSION_STATUSES as readonly string[]).includes(status);

/**
 * The OPEN sub-sessions (any depth) of `root` that follow it — the ids a
 * filing of `root` carries. Bounded ({@link TREE_MAX_DEPTH},
 * {@link TREE_MAX_SESSIONS}); an empty list for a session with no children.
 */
export async function findFollowingSubSessions(
  root: SessionPlacement & { id: string; userId: string },
  database: typeof db = db
): Promise<string[]> {
  const carried: string[] = [];
  const seen = new Set<string>([root.id]);
  let frontier = [root.id];
  for (
    let depth = 0;
    depth < TREE_MAX_DEPTH &&
    frontier.length > 0 &&
    seen.size < TREE_MAX_SESSIONS;
    depth++
  ) {
    const edges = await database
      .select({ childId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.fromType, "session"),
          eq(links.toType, "session"),
          eq(links.linkType, "spawned_from"),
          inArray(links.toId, frontier)
        )
      );
    const childIds = [...new Set(edges.map((e) => e.childId))]
      .filter((id) => !seen.has(id))
      .slice(0, TREE_MAX_SESSIONS - seen.size);
    if (childIds.length === 0) break;
    for (const id of childIds) seen.add(id);
    const children = await database
      .select({
        id: focusSessions.id,
        status: focusSessions.status,
        workspaceId: focusSessions.workspaceId,
        projectId: focusSessions.projectId,
        trackId: focusSessions.trackId,
      })
      .from(focusSessions)
      .where(
        and(
          inArray(focusSessions.id, childIds),
          eq(focusSessions.userId, root.userId)
        )
      );
    const followers = children.filter((c) => samePlacement(c, root));
    for (const c of followers) if (isOpen(c.status)) carried.push(c.id);
    frontier = followers.map((c) => c.id);
  }
  return carried;
}

const isSame = (column: Column, value: string | null) =>
  value === null ? isNull(column) : eq(column, value);

/**
 * File the carried sub-sessions where the root now is: the same filing
 * columns, compare-and-set on the placement they followed (one moved or closed
 * since is left alone). With `proposalId` each change is stamped on that
 * receipt or approved proposal, beside the root's own row patch, so its one
 * Undo restores the tree. Returns the ids it filed.
 */
export async function fileFollowingSubSessions(p: {
  ids: readonly string[];
  userId: string;
  /** Where the root sat before its filing. */
  from: SessionPlacement;
  set: SessionTreeFilingSet;
  /** The receipt / approved proposal whose Undo must restore them too. */
  proposalId?: string;
  database?: typeof db;
}): Promise<string[]> {
  const database = p.database ?? db;
  const filed: string[] = [];
  for (const id of p.ids) {
    const before = p.proposalId
      ? await readSessionUndoSnapshot(database, id)
      : null;
    const [after] = await database
      .update(focusSessions)
      .set({ ...p.set, updatedAt: new Date() })
      .where(
        and(
          eq(focusSessions.id, id),
          eq(focusSessions.userId, p.userId),
          inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
          isSame(focusSessions.workspaceId, p.from.workspaceId),
          isSame(focusSessions.projectId, p.from.projectId),
          isSame(focusSessions.trackId, p.from.trackId)
        )
      )
      .returning({
        projectId: focusSessions.projectId,
        trackId: focusSessions.trackId,
        trackStage: focusSessions.trackStage,
      });
    if (!after) continue;
    filed.push(id);
    await stampSessionUpdate({
      proposalId: p.proposalId,
      sessionId: id,
      before,
      after: before ? { ...before, ...after } : undefined,
      database,
    });
  }
  return filed;
}
