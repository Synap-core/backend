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

import {
  db,
  eq,
  and,
  or,
  inArray,
} from "@synap/database";
import {
  capabilities as capabilitiesTable,
  tools as toolsTable,
  skills as skillsTable,
  links,
} from "@synap/database/schema";
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

    // ── 2. Delete all links touching this container or its members ────────────
    // Pattern: (to_type='capability' AND to_id=containerId)
    //       OR from_id IN members
    //       OR to_id IN members
    const linkConditions = [
      and(eq(links.toType, "capability"), eq(links.toId, containerId)),
    ];
    if (allMemberIds.length > 0) {
      linkConditions.push(inArray(links.fromId, allMemberIds));
      linkConditions.push(inArray(links.toId, allMemberIds));
    }
    await tx.delete(links).where(or(...linkConditions));

    // ── 3. Delete orphaned members ────────────────────────────────────────────
    // A member is orphaned when it has NO remaining member_of link to ANY
    // capability container (after we just deleted this container's links above).
    let deletedTools = 0;
    let deletedSkills = 0;

    if (memberToolIds.length > 0) {
      // Find which tool ids are STILL linked to another capability.
      const stillLinkedTools = await tx
        .select({ fromId: links.fromId })
        .from(links)
        .where(
          and(
            eq(links.toType, "capability"),
            eq(links.linkType, "member_of"),
            inArray(links.fromId, memberToolIds),
            eq(links.fromType, "tool")
          )
        );
      const stillLinkedToolSet = new Set(stillLinkedTools.map((r) => r.fromId));
      const orphanToolIds = memberToolIds.filter(
        (id) => !stillLinkedToolSet.has(id)
      );
      if (orphanToolIds.length > 0) {
        await tx
          .delete(toolsTable)
          .where(inArray(toolsTable.id, orphanToolIds));
        deletedTools = orphanToolIds.length;
      }
    }

    if (memberSkillIds.length > 0) {
      const stillLinkedSkills = await tx
        .select({ fromId: links.fromId })
        .from(links)
        .where(
          and(
            eq(links.toType, "capability"),
            eq(links.linkType, "member_of"),
            inArray(links.fromId, memberSkillIds),
            eq(links.fromType, "skill")
          )
        );
      const stillLinkedSkillSet = new Set(
        stillLinkedSkills.map((r) => r.fromId)
      );
      const orphanSkillIds = memberSkillIds.filter(
        (id) => !stillLinkedSkillSet.has(id)
      );
      if (orphanSkillIds.length > 0) {
        await tx
          .delete(skillsTable)
          .where(inArray(skillsTable.id, orphanSkillIds));
        deletedSkills = orphanSkillIds.length;
      }
    }

    // ── 4. Delete the container row ───────────────────────────────────────────
    await tx
      .delete(capabilitiesTable)
      .where(eq(capabilitiesTable.id, containerId));

    return { success: true as const, deleted: { tools: deletedTools, skills: deletedSkills } };
  });
}
