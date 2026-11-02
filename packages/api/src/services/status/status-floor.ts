/**
 * THE statusOf READ FLOOR — who may read where a subject stands.
 *
 * `readStatusOf` (`status-read.ts`) reads its things, goals and sessions
 * through these, and the realtime status events (`status-realtime.ts`) reach
 * exactly the users they admit. One floor, two consumers: a status event
 * never reaches anyone `statusOf` would answer `unknown`.
 *
 *   thing    the entity read floor (`entityReadVisibleWhere`), not deleted;
 *   role     a role's status is read only through the thing's roles
 *            (`readThingRoles`: THE facet visibility rule AND the entity
 *            floor), so a role's move reaches only who may see that role;
 *   goal     the access layer's rule for `project_tracks` (`scopedDb`);
 *   session  THE session read predicate (`sessionReadableWhere`), as the
 *            statusOf door asks it (no roster branch).
 */
import {
  and,
  db,
  entities,
  eq,
  focusSessions,
  isNull,
  projectTracks,
  runOutsideRequestContext,
  users,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import type { StatusEventSubjectType } from "@synap-core/types/events";
import { AccessContext, scopedDb } from "../../access/index.js";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { readThingRoles } from "./status-roles.js";

/** A thing the reader may read: not deleted, under the entity read floor. */
export function thingStatusFloor(userId: string): SQL {
  return and(isNull(entities.deletedAt), entityReadVisibleWhere(userId))!;
}

/** A session the reader may read (owner floor, the calling key's grant). */
export function sessionStatusFloor(userId: string): SQL {
  return sessionReadableWhere({ userId });
}

/** The access layer as the reader: goals and runs read through its rules. */
export function statusAccess(userId: string) {
  return scopedDb(AccessContext.from({ userId }));
}

/** What a status event is about: a thing (or one of its roles), a goal, a session. */
export interface StatusSubjectRef {
  type: StatusEventSubjectType;
  id: string;
  /** A role's move or signal: the facet whose status it is. */
  facetId?: string | null;
}

/** May `userId` read this subject's status through `statusOf`? THROWS. */
export async function canReadStatus(
  userId: string,
  subject: StatusSubjectRef
): Promise<boolean> {
  switch (subject.type) {
    case "entity": {
      if (subject.facetId) {
        const roles = await readThingRoles(userId, [subject.id]);
        return (roles.get(subject.id) ?? []).some(
          (r) => r.facetId === subject.facetId
        );
      }
      const rows = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.id, subject.id), thingStatusFloor(userId)))
        .limit(1);
      return rows.length > 0;
    }
    case "goal": {
      const rows = await statusAccess(userId).findMany(projectTracks, {
        where: eq(projectTracks.id, subject.id),
        columns: { id: true },
      });
      return rows.length > 0;
    }
    case "session": {
      const rows = await db
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(
          and(eq(focusSessions.id, subject.id), sessionStatusFloor(userId))
        )
        .limit(1);
      return rows.length > 0;
    }
  }
}

/** Readers checked at once (each check is one or two small reads). */
const AUDIENCE_CONCURRENCY = 8;

/**
 * Every user who may read this subject's status — the realtime AUDIENCE of
 * its moves and signals. Each user of the pod is asked through
 * {@link canReadStatus}, so the set is the floor's by construction (pods are
 * small; the channel audience of an object room is read the same way).
 *
 * Read OUTSIDE the request that made the move: the mover's key grant bounds
 * what the MOVER reads, never what another reader may read. THROWS: a failed
 * read is not "nobody", and never "everyone" — the caller sends nothing.
 */
export async function statusAudience(
  subject: StatusSubjectRef
): Promise<string[]> {
  return runOutsideRequestContext(async () => {
    const everyone = await db.select({ id: users.id }).from(users);
    const readers: string[] = [];
    for (let i = 0; i < everyone.length; i += AUDIENCE_CONCURRENCY) {
      const part = everyone.slice(i, i + AUDIENCE_CONCURRENCY);
      const ok = await Promise.all(
        part.map((u) => canReadStatus(u.id, subject))
      );
      part.forEach((u, j) => {
        if (ok[j]) readers.push(u.id);
      });
    }
    return readers;
  });
}
