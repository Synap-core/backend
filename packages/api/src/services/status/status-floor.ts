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
 *            statusOf door asks it (no roster branch);
 *   run      its SESSION's floor when it drives one; a session-less run
 *            (`generate`) the access layer's rule for `playbook_runs`;
 *   proposal the access layer's rule for `proposals` (`scopedDb`);
 *   slot     its SESSION's floor: a slot (`<session id>/<slot key>`) is read
 *            only through the session that declares it.
 *
 * COST: the audience asks every user of the pod (O(users) reads per move).
 * Runs and slots move often (the run reaper's bulk sweeps), so a run's or a
 * slot's audience is MEMOISED per subject for a few seconds
 * ({@link AUDIENCE_TTL_MS}): a burst of moves of one subject reads its
 * floor once. Never longer: a reader who lost access stops receiving within
 * that window.
 */
import {
  and,
  db,
  entities,
  eq,
  focusSessions,
  isNull,
  playbookRuns,
  projectTracks,
  proposals,
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
    case "session":
      return canReadSession(userId, subject.id);
    case "slot": {
      // `<session id>/<slot key>`: the slot is read through its session.
      const slash = subject.id.indexOf("/");
      return slash > 0
        ? canReadSession(userId, subject.id.slice(0, slash))
        : false;
    }
    case "run": {
      // A run that drives a session is read through that session (its
      // owner's floor); a session-less run (`generate`) through the access
      // layer's rule for runs.
      const [run] = await db
        .select({ sessionId: playbookRuns.sessionId })
        .from(playbookRuns)
        .where(eq(playbookRuns.id, subject.id))
        .limit(1);
      if (!run) return false;
      if (run.sessionId) return canReadSession(userId, run.sessionId);
      const rows = await statusAccess(userId).findMany(playbookRuns, {
        where: eq(playbookRuns.id, subject.id),
        columns: { id: true },
      });
      return rows.length > 0;
    }
    case "proposal": {
      const rows = await statusAccess(userId).findMany(proposals, {
        where: eq(proposals.id, subject.id),
        columns: { id: true },
      });
      return rows.length > 0;
    }
  }
}

async function canReadSession(
  userId: string,
  sessionId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(and(eq(focusSessions.id, sessionId), sessionStatusFloor(userId)))
    .limit(1);
  return rows.length > 0;
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
  if (!MEMOISED.has(subject.type)) return readAudience(subject);
  const key = `${subject.type}:${subject.id}`;
  const now = Date.now();
  const hit = audienceMemo.get(key);
  if (hit && hit.until > now) return hit.readers;
  const readers = readAudience(subject);
  audienceMemo.set(key, { until: now + AUDIENCE_TTL_MS, readers });
  // A failed read is not remembered: the next move asks again.
  readers.catch(() => audienceMemo.delete(key));
  if (audienceMemo.size > AUDIENCE_MEMO_MAX) {
    for (const [k, v] of audienceMemo)
      if (v.until <= now) audienceMemo.delete(k);
  }
  return readers;
}

/** How long a run's or a slot's audience is reused (see the header). */
export const AUDIENCE_TTL_MS = 5_000;
const AUDIENCE_MEMO_MAX = 500;
/** The subjects whose audience is memoised: the ones that move in bursts. */
const MEMOISED = new Set<StatusEventSubjectType>(["run", "slot"]);
const audienceMemo = new Map<
  string,
  { until: number; readers: Promise<string[]> }
>();

function readAudience(subject: StatusSubjectRef): Promise<string[]> {
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
