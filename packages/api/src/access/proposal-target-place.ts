/**
 * WHERE A PROPOSAL IS, for a key pinned to projects (app-permission plan
 * 8189ae7c, W1): in the projects its TARGET row is filed in now.
 *
 * `proposals.project_id` is a provenance tag, not a place
 * (`deriveProposalProjectId`, utils/permission-check.ts): the caller's
 * project lens, the producing session's project, the thread's, or the
 * agent's focus. A receipt about a contact outside project P, made inside a
 * session of P, carries P. Reading or deciding by that tag would hand a key
 * pinned to P the patch and the before/after values of a record it cannot
 * read. So, under a project pin, a proposal is in P only when what it is
 * ABOUT is in P:
 *   - `entity`        → the entity is filed in P (`belongs_to_project`);
 *   - `focus_session` → the session's `project_id` is P;
 *   - `track`         → the goal's `project_id` is P;
 *   - `project`       → the project is P.
 * Any other target type is in no project: a project pin fails closed on it.
 *
 * Two halves, side by side so they cannot drift: the READ clause
 * ({@link proposalTargetInProjectsWhere}, `grant-read.ts`) and the DECIDE
 * place ({@link proposalTargetProjectIds}, the decision doors and the
 * withdraw route of `synap_reject_proposal`).
 */

import {
  and,
  db,
  eq,
  getRequestGrant,
  inArray,
  or,
  type KeyGrant,
  type SQL,
} from "@synap/database";
import {
  entities,
  focusSessions,
  projects,
  projectTracks,
  proposals,
  relations,
} from "@synap/database/schema";
import { sql } from "drizzle-orm";
import {
  BELONGS_TO_PROJECT,
  projectLensWhere,
} from "../utils/project-scope.js";

/** READ half: a proposal whose target row is in one of `projectIds`. */
export function proposalTargetInProjectsWhere(projectIds: string[]): SQL {
  return or(
    and(
      eq(proposals.targetType, "entity"),
      inArray(
        proposals.targetId,
        db
          .select({ id: sql<string>`${entities.id}::text` })
          .from(entities)
          .where(projectLensWhere(entities.id, projectIds))
      )
    ),
    and(
      eq(proposals.targetType, "focus_session"),
      inArray(
        proposals.targetId,
        db
          .select({ id: sql<string>`${focusSessions.id}::text` })
          .from(focusSessions)
          .where(inArray(focusSessions.projectId, projectIds))
      )
    ),
    and(
      eq(proposals.targetType, "track"),
      inArray(
        proposals.targetId,
        db
          .select({ id: sql<string>`${projectTracks.id}::text` })
          .from(projectTracks)
          .where(inArray(projectTracks.projectId, projectIds))
      )
    ),
    and(
      eq(proposals.targetType, "project"),
      inArray(proposals.targetId, projectIds)
    )
  )!;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** DECIDE half: the projects a proposal's target row is filed in now. */
export async function proposalTargetProjectIds(proposal: {
  targetType?: string | null;
  targetId?: string | null;
}): Promise<string[]> {
  const id = proposal.targetId;
  if (!id || !UUID.test(id)) return [];
  switch (proposal.targetType) {
    case "entity": {
      const rows = await db
        .select({ id: relations.targetEntityId })
        .from(relations)
        .innerJoin(projects, eq(projects.id, relations.targetEntityId))
        .where(
          and(
            eq(relations.type, BELONGS_TO_PROJECT),
            eq(relations.sourceEntityId, id)
          )
        );
      return [
        ...new Set(rows.map((r) => r.id).filter((p): p is string => !!p)),
      ];
    }
    case "focus_session": {
      const [row] = await db
        .select({ projectId: focusSessions.projectId })
        .from(focusSessions)
        .where(eq(focusSessions.id, id))
        .limit(1);
      return row?.projectId ? [row.projectId] : [];
    }
    case "track": {
      const [row] = await db
        .select({ projectId: projectTracks.projectId })
        .from(projectTracks)
        .where(eq(projectTracks.id, id))
        .limit(1);
      return row?.projectId ? [row.projectId] : [];
    }
    case "project": {
      const [row] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      return row ? [row.id] : [];
    }
    default:
      return [];
  }
}

/**
 * The proposal with `targetProjectIds` set for the decision fence
 * (`assertMayDecideProposalAt`): read only when a scope of the request's key
 * is pinned to projects (no other scope looks at it); null otherwise.
 */
export async function withProposalTargetPlace<
  T extends { targetType?: string | null; targetId?: string | null },
>(
  proposal: T,
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<T & { targetProjectIds: string[] | null }> {
  if (!grant || !grant.scopes.some((scope) => !!scope.projectIds)) {
    return { ...proposal, targetProjectIds: null };
  }
  const ids = await proposalTargetProjectIds(proposal);
  return { ...proposal, targetProjectIds: ids.length ? ids : null };
}
