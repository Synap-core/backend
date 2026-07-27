/**
 * Facet write gate — the ONE predicate deciding who may update/detach an
 * `entity_facets` row. Extracted from `routers/entities.ts` (it gates both
 * `entities.updateFacet` and `entities.detachFacet`) so the rule is testable
 * on its own and cannot drift between the two call sites.
 *
 * The rule, in order (fails CLOSED — anything not matched below is a refusal):
 *
 *   1. The AUTHOR of the facet always writes it.
 *   2. WORKSPACE-scoped facet → shared operational state: an owner/admin/editor
 *      of that workspace may update a role another member attached.
 *   3. POD-WIDE facet (`workspace_id IS NULL`) → there is no workspace whose
 *      membership could grant the write, so the authority is pod-level: a pod
 *      OWNER or ADMIN may write it. Role facets like `client` / `partner` are
 *      attached pod-wide BY DESIGN (so pod-wide reads and the Operations pickup
 *      see them), which previously made them author-only — not even the pod
 *      owner could edit a client's status.
 *
 *      Pod-admin-ness is `isPodAdmin()` (owner/admin of the `pod-admin` system
 *      workspace) — the SAME notion `requirePodAdmin` already gates every other
 *      pod-wide row with (see `tools.ts`'s `if (!existing.workspaceId) await
 *      requirePodAdmin(userId)`) and the same one `projectPodUserAccess` derives
 *      the session `podRole` from. Deliberately NOT `pod_members.pod_role`:
 *      nothing in the codebase ever writes `pod_role='admin'` there (the 0205
 *      backfill writes only 'owner'/'member'), so that table would grant the
 *      owner and silently exclude every admin. One authority notion, not two.
 *
 *      A plain pod member is NOT granted the write here (a member
 *      request/propose path is deliberately out of scope).
 */

import { db, eq, and } from "@synap/database";
import { workspaceMembers } from "@synap/database/schema";
import { isPodAdmin } from "./workspace-role.js";

export async function canWriteFacet(
  facet: { userId: string; workspaceId: string | null },
  userId: string
): Promise<boolean> {
  if (facet.userId === userId) return true;

  if (!facet.workspaceId) {
    return await isPodAdmin(userId);
  }

  const member = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, facet.workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { role: true },
  });
  return (
    member?.role === "owner" ||
    member?.role === "admin" ||
    member?.role === "editor"
  );
}
