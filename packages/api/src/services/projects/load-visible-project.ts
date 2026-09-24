import { and, eq, projects, type getDb } from "@synap/database";
import { ownerPrivateVisibleWhere } from "../../utils/user-visible-where.js";

/**
 * Load a project ONLY if the caller may see it — the ONE visibility floor for
 * single-project reads and for any write that must gate on the project itself.
 *
 * Pod-personal projects (NULL workspace) are owner-only; workspace-scoped ones
 * are visible to every member. Extracted from `get`'s inline predicate so a
 * second caller cannot drift from it — the `automations` read and the
 * membership write both need exactly this floor, and re-typing it is how the
 * two would silently diverge.
 */
export async function loadVisibleProject(
  db: Awaited<ReturnType<typeof getDb>>,
  projectId: string,
  userId: string
): Promise<
  | {
      id: string;
      /** For display (e.g. a filing proposal's title) — never an identifier. */
      name: string;
      workspaceId: string | null;
      userId: string;
      phase: string | null;
      settings: unknown;
    }
  | undefined
> {
  // `userId` / `phase` / `settings` are additive to the original
  // `{ id, workspaceId }`. `userId` is the owner floor a pod-personal
  // project's writes gate on (`assertWorkspaceWrite`, e.g. the tracks
  // service). `phase` feeds `instantiateFromPlaybook`'s legacy `phaseKept`
  // key. `settings` was read by the proto-track to merge `settings.stages`
  // into — nothing writes that any more (tracks pin stages, 0272); it stays
  // selected so no caller silently loses a field. Existing callers
  // destructure only what they use.
  return db.query.projects.findFirst({
    columns: {
      id: true,
      name: true,
      workspaceId: true,
      userId: true,
      phase: true,
      settings: true,
    },
    where: and(
      eq(projects.id, projectId),
      ownerPrivateVisibleWhere(projects.workspaceId, projects.userId, userId)!
    ),
  });
}
