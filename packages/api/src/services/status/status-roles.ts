/**
 * THE ROLES OF A THING, as its reader may see them: the live role facets the
 * status read (`statusOf`'s `roles`, its account line) and the thing's status
 * history (`readTimeline`, subject `entity`) both read, so a role hidden from
 * one is hidden from the other. Read under `roleVisibilityConditions` — THE
 * facet visibility predicate (`facetVisibilityConditions`) AND the entity read
 * floor — for a by-id question (no listing rule, no lens).
 */
import {
  and,
  db,
  entities,
  entityFacets,
  eq,
  inArray,
  isNull,
  profiles,
} from "@synap/database";
import { roleVisibilityConditions } from "../lifecycle/status-groups.js";

export interface ThingRoleRow {
  facetId: string;
  entityId: string;
  profileId: string;
  slug: string;
  name: string;
  /** The facet's lens: the role's lifecycle resolves under it. */
  workspaceId: string | null;
  status: string | null;
  statusCategory: string | null;
}

/** Each thing's visible live roles, oldest attach first. THROWS. */
export async function readThingRoles(
  userId: string,
  entityIds: readonly string[]
): Promise<Map<string, ThingRoleRow[]>> {
  const out = new Map<string, ThingRoleRow[]>();
  if (entityIds.length === 0) return out;
  const visible = await roleVisibilityConditions({
    userId,
    lensWorkspaceId: undefined,
    listing: false,
  });
  const rows = await db
    .select({
      facetId: entityFacets.id,
      entityId: entityFacets.entityId,
      profileId: entityFacets.profileId,
      slug: profiles.slug,
      name: profiles.displayName,
      workspaceId: entityFacets.workspaceId,
      status: entityFacets.status,
      statusCategory: entityFacets.statusCategory,
    })
    .from(entityFacets)
    .innerJoin(profiles, eq(profiles.id, entityFacets.profileId))
    .innerJoin(entities, eq(entities.id, entityFacets.entityId))
    .where(
      and(
        inArray(entityFacets.entityId, [...entityIds]),
        isNull(entityFacets.deletedAt),
        isNull(entities.deletedAt),
        ...visible
      )
    )
    .orderBy(entityFacets.createdAt, entityFacets.id);
  for (const r of rows) {
    out.set(r.entityId, [...(out.get(r.entityId) ?? []), r]);
  }
  return out;
}
