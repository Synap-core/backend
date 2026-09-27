/**
 * The user's DEFAULT workspace when a caller supplied none — the ONE fallback.
 *
 * D7 (concept consolidation): a new pod / user no longer gets an auto-created
 * blank "My Workspace". Their only membership may be the SYSTEM `pod-admin`
 * console. The old fallback — an unordered `workspaceMembers.findFirst` by
 * userId — then silently picked `pod-admin` (it already could, on existing
 * pods: no `orderBy`), filing chat channels, API keys, import proposals and
 * attachments into the operator console.
 *
 * Only a real domain workspace qualifies: never a system workspace
 * (`system_slug` set), never an archived one. `null` means "this user has no
 * workspace" — every caller surfaces that (404 "No workspace found", pod-wide,
 * or a logged skip); none may substitute a guess.
 *
 * Lives in @synap/database (not api) so the bootstrap (`seedAdminUser`) uses
 * the SAME ordered lookup instead of re-deriving an unordered one (RV1 S7).
 * Accepts a transaction handle too (`select` is all it needs).
 */

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { workspaces, workspaceMembers } from "../schema/workspaces.js";
import type { db as dbClient } from "../client-pg.js";

type Selectable = Pick<typeof dbClient, "select">;

export async function findUserDefaultWorkspaceId(
  db: Selectable,
  userId: string,
  /** `first` = earliest joined (stable default); `recent` = most recently updated. */
  order: "first" | "recent" = "first"
): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        isNull(workspaces.systemSlug),
        isNull(workspaces.archivedAt)
      )
    )
    .orderBy(
      order === "recent"
        ? desc(workspaces.updatedAt)
        : asc(workspaceMembers.joinedAt),
      // Tie-break so two memberships joined in the same instant (a bootstrap
      // that seeds several in one tx) still resolve to the SAME row every call.
      asc(workspaceMembers.workspaceId)
    )
    .limit(1);
  return row?.workspaceId ?? null;
}
