/**
 * `ask`'s PROJECT source (ticket 8e2c7018): the `projects` row is the truth;
 * a twin entity (same id, the reserved `project` kind, left by migration
 * 0151) is dropped.
 *
 * Read when the question is about a project: the caller's project lens, or a
 * semantic hit that IS a project (a `project`-kind entity, whose id is its
 * project's). The row (name, description, status, main goal) answers; the
 * twin entity is dropped from the semantic block, since the table is the
 * truth. Through THE project floor (`projectVisibleWhere`) and the calling
 * key's grant, as the find door reads projects. THROWS on a failed read
 * (`ask` reports the lane `error`, never an empty answer).
 */
import {
  and,
  db,
  eq,
  inArray,
  isReservedProfileSlug,
  projects,
  projectTracks,
} from "@synap/database";
import { AccessContext } from "../../access/context.js";
import { projectVisibleWhere } from "../../access/project-visibility.js";
import { grantReadPredicate } from "../../access/grant-read.js";

/**
 * The projects a question is about: the caller's project lens, then each
 * semantic hit of a reserved project kind (its id is its project's, see the
 * header). Its own reader, so `ask` holds no copy of the reserved slugs.
 */
export function projectIdsForAsk(
  projectId: string | null | undefined,
  hits: readonly Record<string, unknown>[]
): string[] {
  const ids = new Set<string>(projectId ? [projectId] : []);
  for (const hit of hits) {
    if (
      typeof hit.id === "string" &&
      typeof hit.type === "string" &&
      isReservedProfileSlug(hit.type)
    ) {
      ids.add(hit.id);
    }
  }
  return [...ids];
}

export async function readProjectsForAsk(input: {
  userId: string;
  projectIds: readonly string[];
}): Promise<Record<string, unknown>[]> {
  if (input.projectIds.length === 0) return [];
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      updatedAt: projects.updatedAt,
      mainGoal: projectTracks.name,
    })
    .from(projects)
    .leftJoin(projectTracks, eq(projectTracks.id, projects.mainGoalId))
    .where(
      and(
        inArray(projects.id, [...input.projectIds]),
        projectVisibleWhere(AccessContext.operator({ userId: input.userId })),
        grantReadPredicate(projects)
      )
    );
  return rows.map((r) => ({
    id: r.id,
    kind: "project",
    name: r.name,
    // The description is the project's body: synthesis reads `content` whole.
    ...(r.description ? { content: r.description } : {}),
    ...(r.status ? { status: r.status } : {}),
    ...(r.mainGoal ? { mainGoal: r.mainGoal } : {}),
    updatedAt:
      r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
  }));
}
