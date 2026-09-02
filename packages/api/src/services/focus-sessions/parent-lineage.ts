/**
 * Read-side projection of `session --spawned_from--> session` lineage onto a
 * focus-session row — `parentSessionId: string | null`, DERIVED from the edge
 * (never a column; see `@synap/database`'s `session-spawn.ts`).
 *
 * Lives in its own module, separate from `routers/focus-sessions.ts`, on
 * purpose: `session-detour-pop.test.ts` source-parses that router file (and
 * the other close doors) to prove NO close/update path resolves a parent —
 * doing so would let closing a detour cascade into closing what it was pushed
 * from. Keeping the lookup here means the router's `list`/`get` (read-only)
 * can use it without that tripwire mistaking a read projection for a close
 * door reaching into the parent.
 *
 * ONE projection, and the ONLY one: the tRPC `focusSessions.get`/`.list` and
 * the MCP `synap_get_session`/`synap_list_sessions`
 * (`routers/mcp/handlers/session.ts`) both import these two functions. A
 * hand-mirrored copy is how the shape forks — there is nothing to keep in
 * lockstep because there is one implementation.
 */

import { getParentSessionId, getParentSessionIds } from "@synap/database";

/** Single-session form — one lookup, for `get`. */
export async function withParentSessionId<T extends { id: string }>(
  session: T
): Promise<T & { parentSessionId: string | null }> {
  const parentSessionId = await getParentSessionId(session.id);
  return { ...session, parentSessionId };
}

/** Batch form — ONE query for the whole page, for `list` (never N+1). */
export async function attachParentSessionIds<T extends { id: string }>(
  sessions: readonly T[]
): Promise<Array<T & { parentSessionId: string | null }>> {
  if (sessions.length === 0) return [];
  const parents = await getParentSessionIds(sessions.map((s) => s.id));
  return sessions.map((s) => ({
    ...s,
    parentSessionId: parents.get(s.id) ?? null,
  }));
}
