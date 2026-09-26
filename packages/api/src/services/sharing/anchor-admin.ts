import { TRPCError } from "@trpc/server";
import { getWorkspaceMembership } from "@synap/database";

/**
 * Administer-the-anchor authz (chantier α, GO-LIVE control #1). Granting anchor
 * membership / exposing a record to an anchor admits a principal to that
 * anchor's exposed set (cross-workspace) — higher-privilege than ordinary edits.
 * So gate on the anchor project's OWNER or a workspace OWNER/ADMIN, NOT a mere
 * editor.
 *
 * ONE definition, shared by `relations.grantAnchorMembership` and every share
 * door (`services/sharing/share-service.ts`, which `relations.exposeToAnchor`
 * now aliases). Moved here from `routers/relations.ts` (Sites W2 S3) so the two
 * doors cannot drift apart.
 */
export async function assertAnchorAdmin(
  db: unknown,
  userId: string,
  anchor: { workspaceId: string | null; userId: string | null }
): Promise<void> {
  if (anchor.userId && anchor.userId === userId) return; // anchor owner
  if (anchor.workspaceId) {
    const m = await getWorkspaceMembership(db, anchor.workspaceId, userId);
    if (m && (m.role === "owner" || m.role === "admin")) return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      "Only the anchor owner or a workspace owner/admin may administer this anchor.",
  });
}
