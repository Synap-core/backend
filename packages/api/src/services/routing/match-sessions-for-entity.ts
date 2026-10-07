/**
 * Session candidates for a captured entity — "enrich a running session".
 *
 * A capture can belong to work that is ALREADY under way: the session about
 * this very thing, or a running playbook session built for this kind of
 * thing. Two sources, both OPEN sessions the capturing person owns:
 *   (a) SUBJECT — `focus_sessions.subject_entity_id` is the captured /
 *       enriched entity itself (strongest: the session is about it);
 *   (b) KIND — the session's playbook declares `subjectProfile.profileSlug`
 *       equal to the entity's kind or one of its live facet roles.
 * Sessions that already have the entity (any `session --*--> entity` edge)
 * are not candidates: there is nothing to add.
 *
 * Access: owner floor (`focus_sessions.user_id`), the same predicate every
 * session read uses (`get` / `attachOutput`). The playbook join reads only
 * the playbook's declared kind, never its rows.
 *
 * The rows become `RouteCandidate`s of kind "session" and are ranked with the
 * playbook and rule candidates by the ONE ranker (`suggest-routes.ts`): case
 * (a) carries `subjectEntityId`, which the ranker reports as a `subject`
 * signal; case (b) carries the playbook's kind as `subjectProfileSlug`, which
 * the ranker reports as `kind` / `facet` exactly as for a playbook.
 */

import {
  db,
  and,
  eq,
  or,
  inArray,
  desc,
  drizzleSql,
  focusSessions,
  links,
  playbooks,
} from "@synap/database";
import type { RouteCandidate } from "./suggest-routes.js";

// SESSION-KIND-LENS-EXEMPT: a narrow projection into `RouteCandidate`s (id,
// name, goal text, kind signal) — no session row reaches a consumer, so there
// is no page for the kind / triage lenses to attach to.

/** Sessions that are being worked — `scheduled` has not started yet. */
const RUNNING_STATUSES = ["active", "paused", "forming"] as const;
/** Pool bound per entity before ranking (the ranker caps the reply). */
const SESSION_POOL = 25;

export async function loadSessionCandidates(input: {
  userId: string;
  entityId: string;
  profileSlug: string;
  facetSlugs?: readonly string[];
}): Promise<RouteCandidate[]> {
  const slugs = [...new Set([input.profileSlug, ...(input.facetSlugs ?? [])])];
  const rows = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      subjectEntityId: focusSessions.subjectEntityId,
      playbookName: playbooks.name,
      playbookSubjectSlug: drizzleSql<
        string | null
      >`${playbooks.subjectProfile}->>'profileSlug'`,
    })
    .from(focusSessions)
    .leftJoin(playbooks, eq(playbooks.id, focusSessions.playbookId))
    .where(
      and(
        eq(focusSessions.userId, input.userId),
        inArray(focusSessions.status, [...RUNNING_STATUSES]),
        or(
          eq(focusSessions.subjectEntityId, input.entityId),
          // OR of scalar `=` params, never `= ANY(array)` (postgres.js
          // driver fault — see playbooks.matchForEntity).
          ...slugs.map(
            (slug) =>
              drizzleSql`${playbooks.subjectProfile}->>'profileSlug' = ${slug}`
          )
        ),
        drizzleSql`NOT EXISTS (
          SELECT 1 FROM ${links}
          WHERE ${links.fromType} = 'session'
            -- links ids are TEXT (polymorphic endpoints); sessions are uuid
            AND ${links.fromId} = ${focusSessions.id}::text
            AND ${links.toType} = 'entity'
            AND ${links.toId} = ${input.entityId}
        )`
      )
    )
    .orderBy(desc(focusSessions.startedAt))
    .limit(SESSION_POOL);

  return rows.map((r) => {
    const aboutIt = r.subjectEntityId === input.entityId;
    return {
      kind: "session" as const,
      id: r.id,
      name: r.title?.trim() || r.goal,
      text: [r.goal, r.playbookName],
      // (a) the subject signal carries it; (b) the playbook's declared kind.
      subjectProfileSlug: aboutIt ? null : (r.playbookSubjectSlug ?? null),
      ...(aboutIt ? { subjectEntityId: input.entityId } : {}),
    };
  });
}
