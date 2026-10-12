/**
 * The space that already holds a template — the target of a template UPDATE.
 *
 * Read by the Hub `/packages/apply` door before governance: an apply of a slug
 * some space already holds is an update of THAT space, so the proposal must
 * name it (its id and its real name), never "Create Space <template name>"
 * with a random target (incident 2026-10-12, `synap market update
 * builder-workspace` with an agent key).
 */
import {
  getDb,
  eq,
  and,
  workspaces,
  userVisibleWhere,
  findWorkspaceIdentityConflict,
} from "@synap/database";

/**
 * The space holding `packageSlug` (pod-wide identity, 0308), as `userId` can
 * see it — or null for a fresh install. Floored to `userVisibleWhere`, so a
 * proposal title never names a space the proposer could not otherwise read; an
 * invisible holder files as before (the approve executor's own identity check
 * refuses it there). A failed read throws — it is never folded into "fresh
 * install".
 */
export async function installedTemplateSpace(
  packageSlug: string,
  userId: string
): Promise<{ id: string; name: string } | null> {
  const dbConn = await getDb();
  const holder = await findWorkspaceIdentityConflict(dbConn, { packageSlug });
  if (!holder) return null;
  const [row] = await dbConn
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, holder.existingWorkspaceId),
        userVisibleWhere(workspaces.id, userId)
      )
    )
    .limit(1);
  return row ?? null;
}
