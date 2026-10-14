/**
 * The PREDICATES of "on these things" — pure SQL over `@synap/database`, no
 * resolution (that is `session-subject.ts`, async: a slug lookup), so the
 * owed/review readers can take a resolved subject without pulling the profile
 * lookup into their import graph.
 *
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
 * PROPOSALS get the same notion (`proposalOnThingsWhere`): a decision is on
 * the things when it targets one, when it would CREATE one / give one the
 * role (a pending `entity/create` / `facet/attach` naming the slug), or when
 * it was filed inside a session on one. That is what an intent surface's
 * "Needs you" reads (`signals.*({ profileSlug })`).
 *
 * Every narrowing here is a WHERE clause applied before the `limit`, never a
 * page filter (see the header of `session-list-conditions.ts`).
 */
import {
  drizzleSql,
  entities,
  entityFacets,
  focusSessions,
  links,
  proposals,
  WORKER_TARGET_LINK_ROLE,
} from "@synap/database";
import type { SQL } from "@synap/database";

/** A subject resolved to rows — what `sessionSubjectWhere` reads. */
export type SessionSubject =
  | { kind: "kind" | "role"; profileIds: string[] }
  | { kind: "entities"; entityIds: string[] };

/**
 * A profile subject resolved for a door that ALSO matches by slug (a pending
 * create carries the slug, not an id). `entityIds` subjects have no slug.
 */
export interface ThingsLens {
  subject: SessionSubject;
  profileSlug?: string;
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

/**
 * THE proposal half of "on these things": targets one (as an entity, or as a
 * facet op on it), creates one / attaches the role (the slug in `data` —
 * nested request envelope first, flat legacy shape second, the executor's
 * own read order), or was filed in a session on one (`sessionSubjectWhere`).
 */
export function proposalOnThingsWhere(lens: ThingsLens): SQL {
  const things = thingIdsText(lens.subject);
  const bySlug = lens.profileSlug
    ? drizzleSql` OR coalesce(${proposals.data}->'data'->>'profileSlug', ${proposals.data}->>'profileSlug') = ${lens.profileSlug}`
    : drizzleSql``;
  return drizzleSql`((${proposals.targetType} IN ('entity', 'entity_facet') AND ${proposals.targetId} IN (${things}))${bySlug} OR ${proposals.sessionId} IN (SELECT ${focusSessions.id} FROM ${focusSessions} WHERE ${sessionSubjectWhere(lens.subject)}))`;
}
