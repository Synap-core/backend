/**
 * The capability a tool belongs to, as ONE reader may see it.
 *
 * A tool (an integration row) is part of a capability through its `member_of`
 * edge (`tool --member_of--> capability`, the edge `resolveToolCapabilityId`
 * in `routers/tools.ts` reads). Pod admin opens a tool on that capability's
 * page (`/open/tool/:id`), so the id is handed out only when the reader can
 * see the capability (`userVisibleWhere`, as the catalog reads containers):
 * a capability they cannot see answers null, and the tool is shown on its own.
 * The oldest edge wins, as everywhere a brick's container is resolved.
 */

import { and, asc, db, drizzleSql, eq } from "@synap/database";
import { capabilities, links } from "@synap/database/schema";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

export async function toolCapabilityForReader(
  userId: string,
  toolId: string
): Promise<string | null> {
  const [edge] = await db
    .select({ capabilityId: capabilities.id })
    .from(links)
    // `links.to_id` is text and `capabilities.id` uuid: the cast is required
    // (Postgres has no uuid = text operator, SQLSTATE 42883).
    .innerJoin(
      capabilities,
      eq(drizzleSql`${capabilities.id}::text`, links.toId)
    )
    .where(
      and(
        eq(links.fromType, "tool"),
        eq(links.fromId, toolId),
        eq(links.linkType, "member_of"),
        eq(links.toType, "capability"),
        userVisibleWhere(capabilities.workspaceId, userId)
      )
    )
    .orderBy(asc(links.createdAt))
    .limit(1);
  return edge?.capabilityId ?? null;
}
