/**
 * "Blocked by an OUTPUT of another session" — DERIVED, with NO new edge type
 * and NO new column.
 *
 * WHY NOTHING IS STORED. `session --blocked_by--> session` (see
 * `session-blocked-by.ts`) is a DECLARED dependency: a human says "this waits
 * on that". The dependency here is an OBSERVED one — it already exists in the
 * graph the moment two sessions point at the same object from opposite ends:
 *
 *     A --targets--> X        (X is A's input / subject)
 *     B --produced--> X       (X is B's output)      A ≠ B
 *
 * ⇒ A is waiting on an output of B. Writing a third edge to say what those two
 * already say would be a second store to keep in lockstep, and it would go
 * stale the instant either end changed. So this module is a READER only; there
 * is no producer, which is also why the `blocked-by-one-producer` tripwire
 * needs no widening.
 *
 * OPEN-ONLY, and that is the whole semantic difference from `produced` edges as
 * history. If B is CLOSED the output already exists — A is not waiting on
 * anything, it is simply consuming a finished thing. A wait therefore requires
 * the PRODUCER to be in an open status (`OPEN_SESSION_STATUSES`, the same
 * constant `openBlockerIds` derives from). The inverse direction obeys the same
 * rule from the other side: B only reports `outputsWaitedOnBy` while B itself
 * is open.
 *
 * OWNER FLOOR — READ THIS BEFORE COPYING THE PATTERN FROM
 * `session-blocked-by.ts`, WHICH FLOORS NOTHING ON THE READ.
 * That reader can skip the floor because its ONE producer floors both endpoints
 * on the same user, so a `blocked_by` edge cannot span two owners. Here there
 * is no such producer: `targets` and `produced` edges are written by ~9 doors
 * onto entities that can live in a SHARED workspace, so the counterparty of a
 * page row can genuinely belong to another user. An unfloored join would
 * therefore disclose another user's session ids. Hence `userId` is REQUIRED,
 * and the counterparty side is floored with an explicit
 * `focus_sessions.userId` join predicate.
 *
 * The PAGE side needs no floor of its own: the ids come from the caller's
 * already-floored query (`queryUserSessions`), exactly as `attachSessionEdges`
 * assumes. Both invariants together mean every id this module returns belongs
 * to `userId`.
 *
 * TWO QUERIES, NOT ONE, and deliberately. The join coordinate is the ENTITY,
 * not the session — the counterparty session is reached only THROUGH X and is
 * usually not on the page. A single query over the page's ids would surface a
 * dependency only when both ends happened to land in the same 20 rows, which
 * makes the answer depend on page size. So: one query to learn the page's
 * entity coordinates, one to fetch every session on the other side of them
 * (floored, with status). Still O(1) in page size, never N+1.
 */

import { db, and, eq, inArray, focusSessions, links } from "@synap/database";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";

/** One "I am waiting on someone else's output" edge, from the waiter's side. */
export interface WaitsOnOutput {
  /** The object being waited on (`links.toId` — an entity). */
  entityId: string;
  /** The still-OPEN session that will produce it. */
  producerSessionId: string;
}

/** The same edge seen from the producer's side. */
export interface OutputWaitedOnBy {
  entityId: string;
  /** The session that targets this output and is therefore waiting. */
  dependentSessionId: string;
}

export interface SessionOutputDependencies {
  /** Outputs of OTHER open sessions that this session takes as input. */
  waitsOnOutputs: WaitsOnOutput[];
  /** Sessions waiting on THIS session's outputs (only while it is open). */
  outputsWaitedOnBy: OutputWaitedOnBy[];
}

/**
 * A FACTORY, not a shared constant: the empty value is spread onto every row
 * with no dependency, and a shared literal would hand all of them the SAME two
 * array instances.
 */
const emptyDependencies = (): SessionOutputDependencies => ({
  waitsOnOutputs: [],
  outputsWaitedOnBy: [],
});

/** The two link types this derivation reads. Nothing else is a dependency. */
const DEPENDENCY_LINK_TYPES = ["targets", "produced"] as const;

/**
 * One side of the join, flattened: "session S relates to entity X as
 * targets|produced, and S is currently open or not".
 */
export interface DependencyEdgeRow {
  sessionId: string;
  entityId: string;
  linkType: "targets" | "produced";
  /** Whether `sessionId` is in an OPEN status. */
  open: boolean;
}

/**
 * THE DERIVATION, pure — so the rule is testable without a database, mirroring
 * `joinSessionOutputs` in `session-outputs.ts`.
 *
 * `rows` must contain every targets/produced edge touching the entities the
 * page's sessions touch (both sides), already owner-floored.
 */
export function joinOutputDependencies(
  pageIds: readonly string[],
  rows: readonly DependencyEdgeRow[]
): Map<string, SessionOutputDependencies> {
  const out = new Map<string, SessionOutputDependencies>();
  if (pageIds.length === 0) return out;
  const page = new Set(pageIds);

  // Group by the join coordinate: the entity.
  const targeters = new Map<string, DependencyEdgeRow[]>();
  const producers = new Map<string, DependencyEdgeRow[]>();
  for (const r of rows) {
    const bucket = r.linkType === "targets" ? targeters : producers;
    const list = bucket.get(r.entityId);
    if (list) list.push(r);
    else bucket.set(r.entityId, [r]);
  }

  const slot = (id: string): SessionOutputDependencies => {
    let s = out.get(id);
    if (!s) {
      s = { waitsOnOutputs: [], outputsWaitedOnBy: [] };
      out.set(id, s);
    }
    return s;
  };
  // A session can target (or produce) the same entity through more than one
  // edge row; the PAIR is the fact, so dedupe on it.
  const seenWait = new Set<string>();
  const seenWaited = new Set<string>();

  for (const [entityId, entityProducers] of producers) {
    const entityTargeters = targeters.get(entityId);
    if (!entityTargeters) continue;

    for (const producer of entityProducers) {
      for (const targeter of entityTargeters) {
        // A ≠ B. A session that targets its own output is not blocked by
        // itself — that is the normal shape of "work on X, produce X".
        if (producer.sessionId === targeter.sessionId) continue;

        // The wait exists only while the PRODUCER is open. A closed producer
        // means the output is already there: history, not a wait.
        if (!producer.open) continue;

        if (page.has(targeter.sessionId)) {
          const key = `${targeter.sessionId}:${entityId}:${producer.sessionId}`;
          if (!seenWait.has(key)) {
            seenWait.add(key);
            slot(targeter.sessionId).waitsOnOutputs.push({
              entityId,
              producerSessionId: producer.sessionId,
            });
          }
        }
        if (page.has(producer.sessionId)) {
          const key = `${producer.sessionId}:${entityId}:${targeter.sessionId}`;
          if (!seenWaited.has(key)) {
            seenWaited.add(key);
            slot(producer.sessionId).outputsWaitedOnBy.push({
              entityId,
              dependentSessionId: targeter.sessionId,
            });
          }
        }
      }
    }
  }

  return out;
}

/**
 * Batch reader — the page's output dependencies in TWO queries (see header).
 * Sessions with no dependency are absent from the map; callers default to
 * empty.
 */
export async function getSessionOutputDependencies(
  sessionIds: readonly string[],
  userId: string
): Promise<Map<string, SessionOutputDependencies>> {
  if (sessionIds.length === 0) return new Map();
  const ids = [...sessionIds];

  // 1. The page's own coordinates — which entities these sessions touch, from
  //    either end. Nothing else can be part of a dependency of theirs.
  const pageEdges = await db
    .select({ toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        inArray(links.fromId, ids),
        inArray(links.linkType, [...DEPENDENCY_LINK_TYPES])
      )
    );
  const entityIds = [...new Set(pageEdges.map((e) => e.toId))];
  if (entityIds.length === 0) return new Map();

  // 2. EVERY session on either side of those entities — including the page's
  //    own rows, so this one result feeds both directions. Owner-floored on the
  //    join, and carrying status so the join can apply the open-only rule.
  const rows = await db
    .select({
      sessionId: links.fromId,
      entityId: links.toId,
      linkType: links.linkType,
      status: focusSessions.status,
    })
    .from(links)
    .innerJoin(
      focusSessions,
      and(eq(focusSessions.id, links.fromId), eq(focusSessions.userId, userId))
    )
    .where(
      and(
        eq(links.fromType, "session"),
        inArray(links.toId, entityIds),
        inArray(links.linkType, [...DEPENDENCY_LINK_TYPES])
      )
    );

  const open = new Set<string>(OPEN_SESSION_STATUSES);
  return joinOutputDependencies(
    ids,
    rows.map((r) => ({
      sessionId: r.sessionId,
      entityId: r.entityId,
      linkType: r.linkType as "targets" | "produced",
      open: open.has(r.status as string),
    }))
  );
}

/**
 * Single-session form. Module-private: the two exported readers below are the
 * only callers, and an unused export is a door nobody walks.
 */
async function getSessionOutputDependenciesFor(
  sessionId: string,
  userId: string
): Promise<SessionOutputDependencies> {
  const map = await getSessionOutputDependencies([sessionId], userId);
  return map.get(sessionId) ?? emptyDependencies();
}

/**
 * The OPEN producer sessions whose outputs `sessionId` is still waiting on.
 * The output-shaped twin of `openBlockerIds`, and the second half of the
 * "last open blocker" rule the unblock reactor applies.
 */
export async function openOutputBlockerIds(
  sessionId: string,
  userId: string
): Promise<string[]> {
  const { waitsOnOutputs } = await getSessionOutputDependenciesFor(
    sessionId,
    userId
  );
  return [...new Set(waitsOnOutputs.map((w) => w.producerSessionId))];
}

/**
 * The sessions that target an output of `sessionId`, IGNORING whether
 * `sessionId` is still open.
 *
 * This is the ONE deliberate exception to the open-only rule, and it exists for
 * the unblock reactor: that reactor runs AFTER the close, so by the time it
 * asks, `getSessionOutputDependenciesFor(closed)` correctly reports nothing —
 * a closed producer is history, not a wait. The reactor needs the set that WAS
 * waiting a moment ago, which is the same set with the producer's status
 * predicate dropped. The dependents' own remaining waits are still re-derived
 * (`openOutputBlockerIds`), so nothing is announced early.
 */
export async function outputDependentsOf(
  sessionId: string,
  userId: string
): Promise<OutputWaitedOnBy[]> {
  const produced = await db
    .select({ toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.fromId, sessionId),
        eq(links.linkType, "produced")
      )
    );
  const entityIds = [...new Set(produced.map((p) => p.toId))];
  if (entityIds.length === 0) return [];

  const targeters = await db
    .select({ sessionId: links.fromId, entityId: links.toId })
    .from(links)
    .innerJoin(
      focusSessions,
      and(eq(focusSessions.id, links.fromId), eq(focusSessions.userId, userId))
    )
    .where(
      and(
        eq(links.fromType, "session"),
        inArray(links.toId, entityIds),
        eq(links.linkType, "targets")
      )
    );

  const seen = new Set<string>();
  const out: OutputWaitedOnBy[] = [];
  for (const t of targeters) {
    // A ≠ B — a session targeting its own output never waited on itself.
    if (t.sessionId === sessionId) continue;
    const key = `${t.entityId}:${t.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entityId: t.entityId, dependentSessionId: t.sessionId });
  }
  return out;
}

/**
 * Attach both dependency directions to a page of session rows — the projection
 * the `list` door uses, mirroring `attachSessionEdges`.
 */
export async function attachSessionOutputDependencies<T extends { id: string }>(
  sessions: readonly T[],
  userId: string
): Promise<Array<T & SessionOutputDependencies>> {
  if (sessions.length === 0) return [];
  const deps = await getSessionOutputDependencies(
    sessions.map((s) => s.id),
    userId
  );
  return sessions.map((s) => ({
    ...s,
    ...(deps.get(s.id) ?? emptyDependencies()),
  }));
}
