/**
 * Links Service — pure functions over the `links` table.
 *
 * `links` is the config/runtime graph (the deliberate mirror of the entity
 * `relations` table). ONE query — getLinksFor — powers every detail page's
 * "related" panel and the capability graph.
 *
 * Dependency-light: only the DB handle + the `links` table + the @synap/playbooks
 * contracts. No governance/event side effects live here — callers (routers / hub
 * REST) own the gate; this layer is the raw store access.
 *
 * Part of the Playbooks & Capability Substrate
 * (team/platform/playbooks-capability-substrate.mdx).
 */

import { getDb, eq, and, or, links } from "@synap/database";
import type { Link } from "@synap/database/schema";
import type { LinkInput, LinkEndpointType, LinkType } from "@synap/playbooks";

/**
 * Create a single link edge. Idempotent on the unique edge
 * (from_type, from_id, to_type, to_id, link_type) — a duplicate insert is a
 * no-op and returns the existing row (or undefined if a concurrent racer won
 * and the conflict skipped the RETURNING row).
 */
export async function createLink(input: LinkInput): Promise<Link | undefined> {
  const db = await getDb();
  const [created] = await db
    .insert(links)
    .values({
      workspaceId: input.workspaceId,
      fromType: input.fromType,
      fromId: input.fromId,
      toType: input.toType,
      toId: input.toId,
      linkType: input.linkType,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [
        links.fromType,
        links.fromId,
        links.toType,
        links.toId,
        links.linkType,
      ],
    })
    .returning();

  return created as Link | undefined;
}

/**
 * Create many link edges in one statement. Idempotent on the unique edge —
 * pre-existing edges are skipped. Returns only the rows actually inserted.
 */
export async function createLinks(inputs: LinkInput[]): Promise<Link[]> {
  if (inputs.length === 0) return [];
  const db = await getDb();
  const created = await db
    .insert(links)
    .values(
      inputs.map((input) => ({
        workspaceId: input.workspaceId,
        fromType: input.fromType,
        fromId: input.fromId,
        toType: input.toType,
        toId: input.toId,
        linkType: input.linkType,
        metadata: input.metadata ?? {},
      }))
    )
    .onConflictDoNothing({
      target: [
        links.fromType,
        links.fromId,
        links.toType,
        links.toId,
        links.linkType,
      ],
    })
    .returning();

  return created as Link[];
}

/**
 * Return EVERY edge touching (type, id) on either end — the one query that
 * powers a detail page's related panel + the capability graph:
 *   WHERE (from_type, from_id) = (type, id) OR (to_type, to_id) = (type, id)
 *
 * `workspaceId` is accepted for call-site symmetry but NOT used to filter:
 * links are addressed by their globally-unique polymorphic endpoint ids, and a
 * workspace filter would wrongly hide pod-wide (workspaceId = NULL) edges that
 * legitimately point at this endpoint. Callers that already scoped the endpoint
 * id get exactly its edges.
 */
export async function getLinksFor(
  _workspaceId: string | null,
  type: LinkEndpointType,
  id: string
): Promise<Link[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(links)
    .where(
      or(
        and(eq(links.fromType, type), eq(links.fromId, id)),
        and(eq(links.toType, type), eq(links.toId, id))
      )
    );

  return rows as Link[];
}

/** Delete a single link edge by id. */
export async function deleteLink(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(links).where(eq(links.id, id));
}
