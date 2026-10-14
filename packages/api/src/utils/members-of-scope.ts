/**
 * membersOf — the LIVE scope of a List built from a Library group.
 *
 * A Build files the group's things under ONE container entity (corpus-map
 * shape, `parent_of` container → member) and records that container on the
 * List's config as `membersOf`. `views.execute` reads it as a SCOPE: the List
 * shows the container's CURRENT members — so when a rebuild attaches a new
 * member with another `parent_of` edge, the List grows without being edited.
 *
 * Same shape as `projectLensWhere` (an EXISTS over the graph, ANDed with the
 * caller's access floor), so it only ever NARROWS what the caller may see: a
 * member the caller cannot read stays hidden, and so does everything when the
 * container is gone.
 */

import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { relations } from "@synap/database";
import { isLikelyUUID } from "@synap-core/types/proposals";

/** The containment edge a Build writes (container → member). */
export const MEMBERS_OF_RELATION = "parent_of" as const;

/** `config.membersOf` when it names an entity id; anything else is no scope. */
export function readMembersOf(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const value = (config as Record<string, unknown>).membersOf;
  return typeof value === "string" && isLikelyUUID(value) ? value : null;
}

/** Rows of `entityIdColumn` that the container holds with a `parent_of` edge. */
export function membersOfWhere(
  entityIdColumn: AnyPgColumn,
  containerEntityId: string
): SQL {
  return sql`exists (select 1 from ${relations} where ${relations.sourceEntityId} = ${containerEntityId} and ${relations.targetEntityId} = ${entityIdColumn} and ${relations.type} = ${MEMBERS_OF_RELATION})`;
}
