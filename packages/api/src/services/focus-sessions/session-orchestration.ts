/**
 * `session --orchestrated_by--> session` — the ONE batch reader of the
 * orchestration edge (founder decision D5; producer:
 * `start-orchestrator.ts`). The FROM session is coordinated by the TO
 * session, its orchestrator. Read beside `blocked_by` by the work graph, so
 * the map draws who coordinates whom.
 *
 * NO OWNER FLOOR ON THE READ, for the reason `getSessionEdges`
 * (`session-blocked-by.ts`) gives: the one producer floors BOTH ends on the
 * same owner, so an edge never joins two people's sessions. Every caller
 * still draws an edge only between two sessions it read through its own
 * floor (the graph's `held` set), so a far end the caller cannot read is
 * never named. A future producer that floors differently must add the floor
 * here first.
 */

import { db, and, eq, inArray, or, links } from "@synap/database";

/** Both directions of the orchestration edge for one session. */
export interface SessionOrchestration {
  /** The orchestrators coordinating this session (outbound `orchestrated_by`). */
  orchestratedBy: string[];
  /** The sessions this one coordinates (inbound `orchestrated_by`). */
  orchestrates: string[];
}

const EMPTY: SessionOrchestration = { orchestratedBy: [], orchestrates: [] };

/**
 * ONE query for a whole page, both directions (never N+1). Sessions with no
 * edge are absent from the map. A failed read THROWS: the caller says
 * `unavailable`, never "no orchestrator".
 */
export async function getSessionOrchestration(
  sessionIds: readonly string[]
): Promise<Map<string, SessionOrchestration>> {
  const out = new Map<string, SessionOrchestration>();
  if (sessionIds.length === 0) return out;
  const ids = [...sessionIds];
  const rows = await db
    .select({ fromId: links.fromId, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "session"),
        eq(links.linkType, "orchestrated_by"),
        or(inArray(links.fromId, ids), inArray(links.toId, ids))
      )
    );
  const page = new Set(ids);
  const bucket = (id: string): SessionOrchestration => {
    let e = out.get(id);
    if (!e) {
      e = { orchestratedBy: [], orchestrates: [] };
      out.set(id, e);
    }
    return e;
  };
  for (const r of rows) {
    if (page.has(r.fromId)) bucket(r.fromId).orchestratedBy.push(r.toId);
    if (page.has(r.toId)) bucket(r.toId).orchestrates.push(r.fromId);
  }
  return out;
}

/** Attach both directions to a page of session rows (as `attachSessionEdges`). */
export async function attachSessionOrchestration<T extends { id: string }>(
  sessions: readonly T[]
): Promise<Array<T & SessionOrchestration>> {
  if (sessions.length === 0) return [];
  const edges = await getSessionOrchestration(sessions.map((s) => s.id));
  return sessions.map((s) => ({ ...s, ...(edges.get(s.id) ?? EMPTY) }));
}
