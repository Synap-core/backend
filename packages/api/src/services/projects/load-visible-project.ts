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
      workspaceId: string | null;
      userId: string;
      phase: string | null;
      settings: unknown;
    }
  | undefined
> {
  // `userId` / `phase` / `settings` are additive to the original
  // `{ id, workspaceId }`: `instantiateFromPlaybook` needs the CURRENT settings
  // to merge into (a wholesale `.set()` on the jsonb would clobber every other
  // key) and the current phase to decide whether it may seed one. Existing
  // callers destructure only what they used before.
  return db.query.projects.findFirst({
    columns: {
      id: true,
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
