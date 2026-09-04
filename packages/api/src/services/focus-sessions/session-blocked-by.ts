/**
 * `session --blocked_by--> session` — the ONE producer and the ONE reader for
 * work-dependency edges between focus sessions.
 *
 * WHY AN EDGE AND NOT A STATUS. A `focus_sessions.status = "blocked"` would
 * destroy the state it replaces (a blocked session is still active, or paused,
 * or scheduled — one column cannot hold both), and it would immediately drift
 * from the blockers themselves: unblocking would mean remembering to write the
 * old status back. Atlassian's flag-don't-status is the shipped prior art.
 * Blocked-ness here is therefore DERIVED, every time, from the subset of edges
 * whose TARGET is still in an open status — see `openBlockerIds` below.
 *
 * The producer mirrors `recordSessionSpawn` (`@synap/database`'s
 * `session-spawn.ts`) exactly:
 *
 *   1. **Owner floor on BOTH endpoints.** `focus_sessions` is owner-private and
 *      carries no `VisibilityRule`, so both sessions are loaded with an explicit
 *      `userId` floor. `spawned_from` only needed to floor the parent because
 *      its child had just been created by the caller; here BOTH ends are
 *      caller-supplied handles, so both are floored.
 *   2. **Drop and report, never throw.** An unowned, missing or malformed
 *      handle returns a reason — a bad handle must not fail the caller.
 *   3. **Idempotent.** The insert conflicts on `idx_links_unique_edge`.
 *
 * The reader mirrors `parent-lineage.ts`: a single form and a BATCH form, ONE
 * implementation imported by every door (tRPC `focusSessions.list`, and the
 * unblock reactor). A hand-mirrored copy is how the shape forks; there is
 * nothing to keep in lockstep because there is one implementation.
 *
 * NO OWNER FLOOR ON THE READS, and that is safe for the same reason
 * `getParentSessionId` is: the producer above floors BOTH endpoints on the same
 * user, so a `blocked_by` edge can only ever connect two sessions with the same
 * owner. A future producer that floors differently silently turns these reads
 * into a cross-user disclosure — add the floor here before adding one.
 */

import {
  db,
  and,
  eq,
  inArray,
  or,
  focusSessions,
  links,
} from "@synap/database";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import { UUID_RE } from "./session-metadata.js";

export interface BlockerEdgeInput {
  /** The session that cannot proceed. */
  sessionId: string;
  /** The session it is waiting on. */
  blockerSessionId: string;
  /** Owner floor — BOTH sessions must belong to this user. */
  userId: string;
  /** Workspace stamped on the edge row (the blocked session's workspace). */
  workspaceId?: string | null;
}

export type BlockerEdgeResult =
  { linked: true } | { linked: false; reason: "not_found" | "self_blocker" };

export type RemoveBlockerResult =
  | { removed: true }
  | { removed: false; reason: "not_found" | "self_blocker" | "no_edge" };

/** Both endpoints exist AND belong to `userId`. Shape-checked first. */
async function bothOwned(
  sessionId: string,
  blockerSessionId: string,
  userId: string
): Promise<boolean> {
  // Shape floor BEFORE the query: `focus_sessions.id` is a `uuid` column, so a
  // malformed handle reaches Postgres as `22P02` — a THROW from a door whose
  // contract is to drop, not fail.
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(blockerSessionId)) return false;

  // Owner floor — never `scopedDb`/`userVisibleWhere`, which have an
  // owner-blind NULL-workspace branch on this table.
  const rows = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.id, [sessionId, blockerSessionId]),
        eq(focusSessions.userId, userId)
      )
    );
  return rows.length === 2;
}

/**
 * Record that `sessionId` is blocked by `blockerSessionId`.
 * Idempotent — a repeat insert is a no-op.
 */
export async function addSessionBlocker(
  input: BlockerEdgeInput
): Promise<BlockerEdgeResult> {
  if (input.sessionId === input.blockerSessionId) {
    return { linked: false, reason: "self_blocker" };
  }
  if (!(await bothOwned(input.sessionId, input.blockerSessionId, input.userId)))
    return { linked: false, reason: "not_found" };

  await db
    .insert(links)
    .values({
      workspaceId: input.workspaceId ?? null,
      fromType: "session",
      fromId: input.sessionId,
      toType: "session",
      toId: input.blockerSessionId,
      linkType: "blocked_by",
      createdBy: input.userId,
      metadata: {},
    })
    .onConflictDoNothing({
      target: [
        links.fromType,
        links.fromId,
        links.toType,
        links.toId,
        links.linkType,
      ],
    });

  return { linked: true };
}

/** Remove the `blocked_by` edge. Reports whether an edge was actually there. */
export async function removeSessionBlocker(
  input: BlockerEdgeInput
): Promise<RemoveBlockerResult> {
  if (input.sessionId === input.blockerSessionId) {
    return { removed: false, reason: "self_blocker" };
  }
  if (!(await bothOwned(input.sessionId, input.blockerSessionId, input.userId)))
    return { removed: false, reason: "not_found" };

  const deleted = await db
    .delete(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.fromId, input.sessionId),
        eq(links.toType, "session"),
        eq(links.toId, input.blockerSessionId),
        eq(links.linkType, "blocked_by")
      )
    )
    .returning({ id: links.id });

  return deleted.length > 0
    ? { removed: true }
    : { removed: false, reason: "no_edge" };
}

/** Both directions of the dependency edge for one session. */
export interface SessionEdges {
  /** Sessions this one is waiting on (outbound `blocked_by`). */
  blockedBy: string[];
  /** Sessions waiting on this one (inbound `blocked_by`). */
  unblocks: string[];
}

const EMPTY_EDGES: SessionEdges = { blockedBy: [], unblocks: [] };

/**
 * Batch form — ONE query for a whole page, both directions (never N+1).
 * Sessions with no edges are absent from the map; callers default to empty.
 */
export async function getSessionEdges(
  sessionIds: readonly string[]
): Promise<Map<string, SessionEdges>> {
  const out = new Map<string, SessionEdges>();
  if (sessionIds.length === 0) return out;

  const ids = [...sessionIds];
  const rows = await db
    .select({ fromId: links.fromId, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "session"),
        eq(links.linkType, "blocked_by"),
        // One query, both directions: an edge is relevant to a page row when
        // EITHER end is on the page.
        or(inArray(links.fromId, ids), inArray(links.toId, ids))
      )
    );

  const page = new Set(ids);
  const bucket = (id: string): SessionEdges => {
    let e = out.get(id);
    if (!e) {
      e = { blockedBy: [], unblocks: [] };
      out.set(id, e);
    }
    return e;
  };
  for (const r of rows) {
    if (page.has(r.fromId)) bucket(r.fromId).blockedBy.push(r.toId);
    if (page.has(r.toId)) bucket(r.toId).unblocks.push(r.fromId);
  }
  return out;
}

/** Single-session form — for `get` and for one-off callers. */
export async function getSessionEdgesFor(
  sessionId: string
): Promise<SessionEdges> {
  const map = await getSessionEdges([sessionId]);
  return map.get(sessionId) ?? EMPTY_EDGES;
}

/**
 * Attach both edge directions to a page of session rows — the projection the
 * `list` door uses, mirroring `attachParentSessionIds`.
 */
export async function attachSessionEdges<T extends { id: string }>(
  sessions: readonly T[]
): Promise<Array<T & SessionEdges>> {
  if (sessions.length === 0) return [];
  const edges = await getSessionEdges(sessions.map((s) => s.id));
  return sessions.map((s) => ({ ...s, ...(edges.get(s.id) ?? EMPTY_EDGES) }));
}

/**
 * The blockers of `sessionId` that are STILL OPEN — i.e. the reason it is
 * blocked right now. Empty ⇒ not blocked (it may still carry closed blocker
 * edges; those are history, and are deliberately not deleted on close).
 *
 * This is the derivation. Nothing stores it.
 */
export async function openBlockerIds(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ blockerId: focusSessions.id })
    .from(links)
    .innerJoin(focusSessions, eq(focusSessions.id, links.toId))
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.fromId, sessionId),
        eq(links.toType, "session"),
        eq(links.linkType, "blocked_by"),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
      )
    );
  return rows.map((r) => r.blockerId);
}
