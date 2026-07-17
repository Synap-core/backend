/**
 * Structured substrate — the ENUMERATIVE lane of the unified knowledge router.
 *
 * When a query is list-shaped ("what are my tasks", "list my companies") and
 * names a typed profile, relevance recall is the wrong tool: the user wants the
 * COMPLETE typed set, not the top-k fuzzy matches (and with the embedding
 * provider down, fuzzy recall degrades to keyword-only — worse still). This
 * dispatches a scoped, TYPED entity query through the SAME access doors
 * `entities.list` uses — the `workspaceLensWhere`/`accessScopeWhere` floor plus
 * the `profileSlugScopeCondition` polymorphic type match — never a hand-rolled
 * scope. Minimal by design: a profile + one optional status filter (tasks); no
 * general query language.
 */
import {
  db,
  entities,
  and,
  isNull,
  desc,
  drizzleSql,
  profileSlugScopeCondition,
} from "@synap/database";
import { workspaceLensWhere } from "../../utils/user-visible-where.js";
import {
  accessScopeWhere,
  projectLensWhere,
} from "../../utils/project-scope.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";

export interface StructuredParams {
  /** Catalog-resolved profile slug the enumerative query named. */
  profileSlug: string;
  userId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  /** Optional status word — applied to the task lane only (see TASK_STATUS_SYNONYMS). */
  status?: string;
  limit: number;
}

/**
 * Spoken task-status words → the seeded `task.status` enum values
 * (todo / in-progress / done / cancelled — see ensure-system-profiles). Only the
 * words T1 supports; an unmapped word yields NO filter (return all of the
 * profile, honestly, rather than silently matching zero).
 */
const TASK_STATUS_SYNONYMS: Record<string, string> = {
  open: "todo",
  pending: "todo",
  todo: "todo",
  done: "done",
  complete: "done",
  completed: "done",
};

/**
 * Run the typed enumerative query. Returns raw entity rows (same shape the
 * semantic substrate surfaces) so the router can present them alongside the
 * other substrates with an identical item shape.
 */
export async function structuredLookup(
  params: StructuredParams
): Promise<Record<string, unknown>[]> {
  const { profileSlug, userId, workspaceId, projectId, status, limit } = params;

  // SAME floor doors as entities.list, but the enumerative lane INCLUDES
  // pod-wide rows even under a workspace lens: enumeration is a
  // user-floor VISIBILITY question (everything the caller can see, incl.
  // pod-scoped task/person/company at workspaceId NULL — entityScope
  // 'pod' means visible in all workspaces). A focused lens without
  // globals returned 1 of 10 open tasks in live verification. The
  // 2026-06-15 no-bleed decision still governs BROWSE
  // (includePodWide=false default).
  const floor = projectId
    ? accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId,
      })
    : workspaceLensWhere(entities.workspaceId, userId, workspaceId ?? undefined, {
        includeGlobals: true,
      });

  const facetVisibilityScope = await resolveFacetVisibilityScope(
    userId,
    projectId ? undefined : workspaceId
  );

  const conditions = [
    isNull(entities.deletedAt),
    floor,
    // Polymorphic type match (kind → entities.type; role → facet EXISTS) — the
    // one door entities.list resolves a single caller-supplied slug through.
    await profileSlugScopeCondition(db, profileSlug, facetVisibilityScope),
  ];

  if (projectId) conditions.push(projectLensWhere(entities.id, projectId));

  // Optional status filter (task lane only). Map the spoken word to the seeded
  // enum; an unrecognized word or a non-task profile → no filter (return all).
  if (status && profileSlug === "task") {
    const mapped = TASK_STATUS_SYNONYMS[status.toLowerCase()];
    if (mapped) {
      conditions.push(
        drizzleSql`${entities.properties}->>'status' = ${mapped}`
      );
    }
  }

  const rows = await db.query.entities.findMany({
    where: and(...conditions),
    orderBy: [desc(entities.createdAt)],
    limit,
  });
  return rows as Record<string, unknown>[];
}
