/**
 * WHO acted, named — the ONE projection of a pod user id to an
 * `ActivityActor` (`@synap-core/types/activity`), shared by every "what
 * happened" read: the activity ledger (`list-activity.ts`), the track history
 * (`services/tracks/track-history.ts`) and the track view's stage-history
 * movers. Names are resolved HERE, server-side: a client cannot (Relay's
 * signed-in id is the Control Plane's, never a pod user id).
 */

import { db, inArray, users } from "@synap/database";
import type { ActivityActor } from "@synap-core/types/activity";
import { displayNameForUser } from "../../routers/proposals/helper-functions.js";

export interface ActorUserRow {
  id: string;
  name: string | null;
  email: string;
  userType: string;
  agentMetadata: unknown;
}

/**
 * One actor. `isAgent` is the caller's own evidence an agent acted (e.g. a
 * proposal's `agent_user_id`); a user row typed `agent` is one regardless.
 * No id ⇒ `system` (a rule, a check) — never a guessed person.
 */
export function activityActorOf(
  actorId: string | null | undefined,
  row: ActorUserRow | undefined,
  viewer: string,
  isAgent = false
): ActivityActor {
  const name = row ? (displayNameForUser(row as never) ?? null) : null;
  if (isAgent || row?.userType === "agent") {
    return { kind: "agent", id: actorId ?? null, name };
  }
  if (!actorId) return { kind: "system", id: null, name: null };
  return { kind: "human", id: actorId, name, isViewer: actorId === viewer };
}

/** The user rows for `ids`, in ONE query. A failed read THROWS. */
export async function loadActorRows(
  ids: Iterable<string | null | undefined>,
  database: typeof db = db
): Promise<Map<string, ActorUserRow>> {
  const uniq = [...new Set([...ids].filter((x): x is string => Boolean(x)))];
  if (uniq.length === 0) return new Map();
  const rows = await database
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      userType: users.userType,
      agentMetadata: users.agentMetadata,
    })
    .from(users)
    .where(inArray(users.id, uniq));
  return new Map(rows.map((r) => [r.id, r as ActorUserRow]));
}
