/**
 * Capability Uninstaller — tear down a capability container and its orphaned members.
 *
 * Deletion logic (links table is POLYMORPHIC — from_id/to_id are TEXT, no FK):
 *   1. Collect member ids: from_id of links where to_type='capability' AND to_id=containerId.
 *   2. Delete links where (to_type='capability' AND to_id=containerId)
 *      OR from_id IN members OR to_id IN members.
 *   3. Delete member skills/tools that are NOT linked to any OTHER capability
 *      container (orphans only — shared members are preserved).
 *   4. Delete the container row itself.
 *
 * All steps run inside a single transaction so a crash leaves the DB consistent.
 */

import { db, eq, and, or, inArray } from "@synap/database";
import {
  capabilities as capabilitiesTable,
  tools as toolsTable,
  skills as skillsTable,
  links,
  secrets as secretsTable,
} from "@synap/database/schema";
import { isNull } from "@synap/database";
import type { Context } from "../../types/context.js";

/**
 * Uninstall a capability container by id.
 *
 * Does NOT accept a workspaceId from the caller — it is loaded from the
 * container row itself, so the caller cannot spoof scope.
 *
 * Auth (enforced by the caller / tRPC procedure):
 *   - container.workspaceId non-null → workspace owner
 *   - container.workspaceId null    → pod admin
 */
export async function uninstallCapability(
  containerId: string,
  _ctx: Context
): Promise<{ success: true; deleted: { tools: number; skills: number } }> {
  return db.transaction(async (tx) => {
    // ── 1. Collect member ids ─────────────────────────────────────────────────
    const memberLinks = await tx
      .select({ fromType: links.fromType, fromId: links.fromId })
      .from(links)
      .where(
        and(
          eq(links.toType, "capability"),
          eq(links.toId, containerId),
          eq(links.linkType, "member_of")
        )
      );

    const memberToolIds = memberLinks
      .filter((l) => l.fromType === "tool")
      .map((l) => l.fromId);
    const memberSkillIds = memberLinks
      .filter((l) => l.fromType === "skill")
      .map((l) => l.fromId);
    const allMemberIds = memberLinks.map((l) => l.fromId);

    // ── 2. Classify orphan vs SHARED members — BEFORE any delete ──────────────
    // A member is SHARED when it is `member_of` another capability too; those
    // must survive (with their other links). We compute this from a snapshot
    // taken BEFORE deleting any links — deleting first would make the surviving
    // links invisible to a follow-up query (read-your-writes inside the txn),
    // which would misclassify every shared member as an orphan and delete it.
    const sharedToolIds = new Set<string>();
    const sharedSkillIds = new Set<string>();
    if (allMemberIds.length > 0) {
      const otherCapLinks = await tx
        .select({
          fromType: links.fromType,
          fromId: links.fromId,
          toId: links.toId,
        })
        .from(links)
        .where(
          and(
            eq(links.toType, "capability"),
            eq(links.linkType, "member_of"),
            inArray(links.fromId, allMemberIds)
          )
        );
      for (const l of otherCapLinks) {
        if (l.toId === containerId) continue; // this container's own edge
        if (l.fromType === "tool") sharedToolIds.add(l.fromId);
        else if (l.fromType === "skill") sharedSkillIds.add(l.fromId);
      }
    }
    const orphanToolIds = memberToolIds.filter((id) => !sharedToolIds.has(id));
    const orphanSkillIds = memberSkillIds.filter(
      (id) => !sharedSkillIds.has(id)
    );
    const orphanIds = [...orphanToolIds, ...orphanSkillIds];

    // ── 3. Delete links: this container's member edges + the ORPHANS' links ───
    // Shared members KEEP their links to the other capabilities they belong to,
    // so we never touch a link unless it points at this container or at an orphan.
    const linkConditions = [
      and(eq(links.toType, "capability"), eq(links.toId, containerId)),
    ];
    if (orphanIds.length > 0) {
      linkConditions.push(inArray(links.fromId, orphanIds));
      linkConditions.push(inArray(links.toId, orphanIds));
    }
    await tx.delete(links).where(or(...linkConditions));

    // ── 4. Delete the orphaned members (shared members are preserved) ─────────
    let deletedTools = 0;
    let deletedSkills = 0;
    if (orphanToolIds.length > 0) {
      await tx.delete(toolsTable).where(inArray(toolsTable.id, orphanToolIds));
      deletedTools = orphanToolIds.length;
    }
    if (orphanSkillIds.length > 0) {
      await tx
        .delete(skillsTable)
        .where(inArray(skillsTable.id, orphanSkillIds));
      deletedSkills = orphanSkillIds.length;
    }

    // ── 5. Delete the container row ───────────────────────────────────────────
    await tx
      .delete(capabilitiesTable)
      .where(eq(capabilitiesTable.id, containerId));

    // ── 6. Soft-delete this capability's connection rows ──────────────────────
    // The vault (`secrets`) IS the connection registry: rows with this
    // `capability_id` are the capability's stored connections. With the
    // capability gone they're meaningless, so soft-delete them (recoverable, and
    // it keeps the vault free of dangling connection rows). Plain personal-vault
    // entries (capability_id NULL) are never touched.
    await tx
      .update(secretsTable)
      .set({ deletedAt: new Date(), isDefault: false })
      .where(
        and(
          eq(secretsTable.capabilityId, containerId),
          isNull(secretsTable.deletedAt)
        )
      );

    return {
      success: true as const,
      deleted: { tools: deletedTools, skills: deletedSkills },
    };
  });
}
