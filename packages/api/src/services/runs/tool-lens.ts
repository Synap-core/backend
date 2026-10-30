/**
 * The TOOL lens's address: which skills' runs are "this tool's runs".
 *
 * A capability has no run of its own: what runs is one of its actions, and an
 * action is a skill linked into the container (`skill --member_of-->
 * capability`, the same edges `buildCapabilityCatalog` folds into a card's
 * verbs). So a capability's runs are the runs of its member skills, and a
 * skill's runs are its own. The runs themselves are read through the
 * capability-run predicates (`capability-run-where.ts`, `RunScope.skillIds`),
 * user-floored as ever.
 *
 * The container is read under the reader's floor first (`userVisibleWhere`,
 * as the catalog reads it): a capability they cannot see answers `null`, which
 * the door turns into NOT_FOUND, never into "it never ran".
 */

import { and, db, eq } from "@synap/database";
import { capabilities, links } from "@synap/database/schema";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

export type ToolRef = { capabilityId: string } | { skillId: string };

/**
 * The skill ids whose runs are this tool's runs, or `null` when the reader
 * cannot see the capability. A capability with no action answers `[]`.
 */
export async function resolveToolSkillIds(
  userId: string,
  tool: ToolRef
): Promise<string[] | null> {
  if ("skillId" in tool) return [tool.skillId];
  const [container] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(
      and(
        eq(capabilities.id, tool.capabilityId),
        userVisibleWhere(capabilities.workspaceId, userId)
      )
    )
    .limit(1);
  if (!container) return null;
  const members = await db
    .select({ skillId: links.fromId })
    .from(links)
    .where(
      and(
        eq(links.toType, "capability"),
        eq(links.toId, container.id),
        eq(links.linkType, "member_of"),
        eq(links.fromType, "skill")
      )
    );
  return [...new Set(members.map((m) => m.skillId))];
}
