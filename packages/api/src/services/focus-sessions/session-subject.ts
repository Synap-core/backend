/**
 * "Sessions ON these things" — the SUBJECT narrow of the ONE session WHERE
 * (`sessionListConditions`).
 *
 * A session is on a thing when either
 *   - the thing is its SUBJECT (`focus_sessions.subject_entity_id`, the
 *     subject-spine anchor), or
 *   - it is a WORKER session that TARGETS the thing (`links` session
 *     --targets--> entity with `metadata.role = 'worker_target'`, written by
 *     the stage worker, work model L4). Settled targets count too: a worker
 *     that finished with a thing still worked on it; narrow by `status` for
 *     "being worked now".
 *
 * The things are named either by ID (a thing page: one entity) or by a
 * PROFILE SLUG (an intent surface: every thing of a kind, or every thing that
 * carries a role). The slug resolves through the board's own rule
 * (`statusSubjectOfRows`: a slug with a role row is a role), so "the sessions
 * on Leads" and "the Leads board" can never mean two populations.
 *
 * VISIBILITY. The predicate only NARROWS rows the session floor
 * (`sessionReadableWhere`) already admits; it returns no entity data. So the
 * thing set is not re-floored here — a session the caller may read is listed
 * whichever thing it is on. The session's own workspace/project lens is the
 * lens; it is the same lens the board takes.
 *
 * Every narrowing here is a WHERE clause applied before the `limit`, never a
 * page filter (see the header of `session-list-conditions.ts`).
 */
import { z } from "zod";
import {
  db,
  drizzleSql,
  focusSessions,
  links,
  WORKER_TARGET_LINK_ROLE,
} from "@synap/database";
import { entities, entityFacets } from "@synap/database/schema";
import type { SQL } from "@synap/database";
import { assertKnownProfileSlug } from "../../utils/assert-known-profile-slug.js";
import { statusSubjectOfRows } from "../../routers/entities/status-groups.js";

/** The wire shape every door takes: a profile slug OR explicit entity ids. */
export const sessionSubjectInputSchema = z.union([
  z.object({ profileSlug: z.string().min(1) }).strict(),
  z.object({ entityIds: z.array(z.string().uuid()).min(1).max(200) }).strict(),
]);
export type SessionSubjectInput = z.infer<typeof sessionSubjectInputSchema>;

/** A subject resolved to rows — what `sessionSubjectWhere` reads. */
export type SessionSubject =
  | { kind: "kind" | "role"; profileIds: string[] }
  | { kind: "entities"; entityIds: string[] };

/**
 * Resolve a door's subject input. An unknown slug THROWS (NOT_FOUND via
 * `assertKnownProfileSlug`) — "no such vocabulary" is not "no sessions".
 */
export async function resolveSessionSubject(
  input: SessionSubjectInput
): Promise<SessionSubject> {
  if ("entityIds" in input) {
    return { kind: "entities", entityIds: [...new Set(input.entityIds)] };
  }
  const rows = await assertKnownProfileSlug(db, input.profileSlug);
  const { subject } = statusSubjectOfRows(input.profileSlug, rows);
  return { kind: subject.kind, profileIds: subject.profileIds };
}

/** The ids (as text) of the live things the subject names. */
function thingIdsText(subject: SessionSubject): SQL {
  if (subject.kind === "entities") {
    return drizzleSql.join(
      subject.entityIds.map((id) => drizzleSql`${id}`),
      drizzleSql`, `
    );
  }
  const ids = subject.profileIds.length
    ? drizzleSql.join(
        subject.profileIds.map((id) => drizzleSql`${id}::uuid`),
        drizzleSql`, `
      )
    : drizzleSql`NULL::uuid`;
  return subject.kind === "role"
    ? drizzleSql`SELECT sf.entity_id::text FROM ${entityFacets} sf JOIN ${entities} se ON se.id = sf.entity_id WHERE sf.profile_id IN (${ids}) AND sf.deleted_at IS NULL AND se.deleted_at IS NULL`
    : drizzleSql`SELECT se.id::text FROM ${entities} se WHERE se.profile_id IN (${ids}) AND se.deleted_at IS NULL`;
}

/** THE predicate: the session's subject is one of the things, or it targets one as a worker. */
export function sessionSubjectWhere(subject: SessionSubject): SQL {
  const things = thingIdsText(subject);
  return drizzleSql`(${focusSessions.subjectEntityId}::text IN (${things}) OR EXISTS (SELECT 1 FROM ${links} sl WHERE sl.from_type = 'session' AND sl.from_id = ${focusSessions.id}::text AND sl.to_type = 'entity' AND sl.link_type = 'targets' AND sl.metadata->>'role' = ${WORKER_TARGET_LINK_ROLE} AND sl.to_id IN (${things})))`;
}
