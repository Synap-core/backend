/**
 * SITE MEMBERS — "which records does a site serve right now", decided ONCE
 * (collection door C1b). The public collection and record doors, the
 * manifest's counts and the owner's site status all read members through
 * {@link liveMemberWhere}, so a count, a list and a direct read can never
 * disagree about one record.
 *
 * A member row (0336) is a record's publication INTO a site: `resource_type =
 * 'entity'`, `audience = 'public'`, `site_share_id` = the site row. Its CONTENT
 * is a snapshot taken by an explicit publish act; its MEMBERSHIP only ever
 * narrows at read time. A member is served only while ALL of these hold NOW:
 *   - the row is published, not revoked, not expired (`isPublicationLive`'s
 *     `via: "site"` rule, as SQL);
 *   - the entity still exists (not soft-deleted);
 *   - the record is still filed into the site's project (`belongs_to_project`
 *     edge, source = the record, target = the project);
 *   - the member's OWN workspace has its public doors open (a member in a
 *     closed space is silently left out; only the site's home-space switch
 *     answers 403, and the caller decides that one).
 * Each check can only REMOVE rows. The site row's own liveness (published,
 * token, project exists) is the caller's: these helpers take a site the
 * caller already resolved.
 *
 * Kept apart from the owner doors so the credentialless read never imports
 * the write gate.
 */

import { db, and, eq, inArray, isNull, isNotNull, or } from "@synap/database";
import { entities, relations, resourceShares } from "@synap/database/schema";
import { count, exists, gt, sql, type SQL } from "drizzle-orm";
import { BELONGS_TO_PROJECT } from "../../utils/project-scope.js";
import { publicDoorsOpenFor } from "./public-doors-switch.js";

/** A site the caller resolved: its row id and its project. */
export interface SiteRef {
  id: string;
  projectId: string;
}

/**
 * The workspaces of a site's published members whose public doors are open.
 * Few (a site's records come from a handful of spaces), each switch read once.
 */
export async function openMemberWorkspaces(siteId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workspaceId: resourceShares.workspaceId })
    .from(resourceShares)
    .where(
      and(
        eq(resourceShares.siteShareId, siteId),
        eq(resourceShares.state, "published"),
        isNull(resourceShares.revokedAt)
      )
    );
  const open: string[] = [];
  for (const { workspaceId } of rows) {
    // A member always carries a workspace; one without is never served.
    if (workspaceId && (await publicDoorsOpenFor(workspaceId))) {
      open.push(workspaceId);
    }
  }
  return open;
}

/**
 * THE predicate over `resource_shares`: the site's members served right now
 * (see the header). `openWorkspaceIds` comes from {@link openMemberWorkspaces}.
 */
export function liveMemberWhere(
  site: SiteRef,
  openWorkspaceIds: readonly string[],
  now: Date = new Date()
): SQL {
  if (openWorkspaceIds.length === 0) return sql`false`;
  return and(
    eq(resourceShares.siteShareId, site.id),
    eq(resourceShares.audience, "public"),
    eq(resourceShares.resourceType, "entity"),
    eq(resourceShares.state, "published"),
    isNull(resourceShares.revokedAt),
    isNotNull(resourceShares.publishedAt),
    or(isNull(resourceShares.expiresAt), gt(resourceShares.expiresAt, now)),
    inArray(resourceShares.workspaceId, [...openWorkspaceIds]),
    exists(
      db
        .select({ one: sql`1` })
        .from(entities)
        .where(
          and(
            eq(entities.id, resourceShares.resourceId),
            isNull(entities.deletedAt)
          )
        )
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(relations)
        .where(
          and(
            eq(relations.type, BELONGS_TO_PROJECT),
            eq(relations.sourceEntityId, resourceShares.resourceId),
            eq(relations.targetEntityId, site.projectId)
          )
        )
    )
  )!;
}

/**
 * Live members per collection key — the manifest's `count`, the owner
 * status's count and the collection door's `total` are the same number.
 */
export async function liveMemberCounts(
  site: SiteRef,
  keys: readonly string[]
): Promise<Map<string, number>> {
  const counts = new Map(keys.map((k) => [k, 0]));
  if (keys.length === 0) return counts;
  const open = await openMemberWorkspaces(site.id);
  const rows = await db
    .select({
      collection: resourceShares.publishedCollection,
      n: count(),
    })
    .from(resourceShares)
    .where(
      and(
        liveMemberWhere(site, open),
        inArray(resourceShares.publishedCollection, [...keys])
      )
    )
    .groupBy(resourceShares.publishedCollection);
  for (const { collection, n } of rows) {
    if (collection && counts.has(collection)) counts.set(collection, n);
  }
  return counts;
}
