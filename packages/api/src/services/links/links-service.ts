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

import { getDb, eq, and, or, inArray, links } from "@synap/database";
import type { Link } from "@synap/database/schema";
import type { LinkInput, LinkEndpointType } from "@synap/playbooks";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

/**
 * Create a single link edge. Idempotent on the unique edge
 * (from_type, from_id, to_type, to_id, link_type) — a duplicate insert is a
 * no-op and returns the existing row (or undefined if a concurrent racer won
 * and the conflict skipped the RETURNING row).
 */
// NOTE: reserved for P5 link UI (ad-hoc single-edge writes). Today every link
// write goes through `createLinks` (batch); this single-item form has no caller yet.
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
 * SCOPED: results are restricted to edges the user may see —
 * `userVisibleWhere(links.workspaceId, userId)` = pod-wide (workspaceId NULL)
 * OR a workspace the user belongs to. Without this, any authenticated user could
 * read the link graph of workspaces they're not a member of.
 */
export async function getLinksFor(
  userId: string,
  type: LinkEndpointType,
  id: string
): Promise<Link[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(links)
    .where(
      and(
        userVisibleWhere(links.workspaceId, userId),
        or(
          and(eq(links.fromType, type), eq(links.fromId, id)),
          and(eq(links.toType, type), eq(links.toId, id))
        )
      )
    );

  return rows as Link[];
}

/** Delete a single link edge by id. */
// NOTE: reserved for P5 link UI (unlink). No caller yet — link removal is not
// yet exposed; when it is, the caller must gate (links-service is caller-gated).
export async function deleteLink(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(links).where(eq(links.id, id));
}

/**
 * Extract capability refs from a set of links. Shared helper used by
 * playbook-lifecycle (promoteSessionToPlaybook) and run-playbook (runPlaybook)
 * to convert link edges into typed CapabilityRef arrays, filtering to the
 * grantable kinds (tool, skill, command).
 *
 * The grant edge's JSONB `metadata` is threaded through (optional, additive) so a
 * capability-execution gate can read the per-grant `execMode` recorded on the
 * `grants` link. Existing callers that ignore `metadata` are unaffected.
 */
export function extractCapabilities(
  links: {
    linkType: string;
    fromType: string;
    toType: string;
    toId: string;
    metadata?: unknown;
  }[],
  opts: { linkType: string; fromType: string }
): {
  kind: "tool" | "skill" | "command";
  id: string;
  metadata?: Record<string, unknown>;
}[] {
  return links
    .filter((l) => l.linkType === opts.linkType && l.fromType === opts.fromType)
    .map((l) => ({
      kind: l.toType as "tool" | "skill" | "command",
      id: l.toId,
      metadata:
        l.metadata &&
        typeof l.metadata === "object" &&
        !Array.isArray(l.metadata)
          ? (l.metadata as Record<string, unknown>)
          : undefined,
    }))
    .filter(
      (c) => c.kind === "tool" || c.kind === "skill" || c.kind === "command"
    );
}

/**
 * Resolve a capability CONTAINER's runnable member parts via the `member_of`
 * graph (`tool|skill|command --member_of--> capability`). The shared expansion
 * used by BOTH grant resolution (run-playbook) and grant issuance (session
 * grantCapability). Returns each part's kind + id + the capability it belongs to
 * (so callers can attribute per-capability metadata / grant scope).
 */
export async function getCapabilityMemberParts(
  capabilityIds: string[]
): Promise<
  { kind: "tool" | "skill" | "command"; id: string; capabilityId: string }[]
> {
  if (capabilityIds.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .select({
      fromType: links.fromType,
      fromId: links.fromId,
      toId: links.toId,
    })
    .from(links)
    .where(
      and(
        eq(links.toType, "capability"),
        inArray(links.toId, capabilityIds),
        eq(links.linkType, "member_of")
      )
    );
  // Dedup by kind+id so a part shared by two granted containers (or a duplicate
  // member_of edge) yields ONE part — callers issuing per-part rows must not
  // double-insert. First occurrence wins its capabilityId (for metadata attrib).
  const seen = new Set<string>();
  return rows
    .filter(
      (m) =>
        m.fromType === "tool" ||
        m.fromType === "skill" ||
        m.fromType === "command"
    )
    .map((m) => ({
      kind: m.fromType as "tool" | "skill" | "command",
      id: m.fromId,
      capabilityId: m.toId,
    }))
    .filter((p) => {
      const key = `${p.kind}:${p.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Capability-aware grant resolution. Same as `extractCapabilities` for direct
 * `tool|skill|command` grant edges, but ADDITIONALLY fans out grant edges that
 * target a capability CONTAINER (`toType === "capability"`) into that container's
 * member parts.
 *
 * This is the ONE seam that makes a Capability the grantable unit: granting a
 * capability to a playbook/session grants all its parts, while the gate stays
 * per-(kind,id) and unchanged. The capability grant edge's `metadata` (e.g. the
 * recorded `execMode`) is inherited by each expanded member. Direct part grants
 * win over inherited ones on a kind+id collision.
 */
export async function resolveGrantedCapabilities(
  edges: {
    linkType: string;
    fromType: string;
    toType: string;
    toId: string;
    metadata?: unknown;
  }[],
  opts: { linkType: string; fromType: string }
): Promise<
  {
    kind: "tool" | "skill" | "command";
    id: string;
    metadata?: Record<string, unknown>;
  }[]
> {
  const direct = extractCapabilities(edges, opts);

  const capEdges = edges.filter(
    (l) =>
      l.linkType === opts.linkType &&
      l.fromType === opts.fromType &&
      l.toType === "capability"
  );
  if (capEdges.length === 0) return direct;

  const asMeta = (m: unknown): Record<string, unknown> | undefined =>
    m && typeof m === "object" && !Array.isArray(m)
      ? (m as Record<string, unknown>)
      : undefined;
  const metaByCap = new Map<string, Record<string, unknown> | undefined>();
  for (const e of capEdges) metaByCap.set(e.toId, asMeta(e.metadata));

  const members = await getCapabilityMemberParts([
    ...new Set(capEdges.map((e) => e.toId)),
  ]);

  const seen = new Set(direct.map((c) => `${c.kind}:${c.id}`));
  const merged = [...direct];
  for (const m of members) {
    const key = `${m.kind}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      kind: m.kind,
      id: m.id,
      metadata: metaByCap.get(m.capabilityId),
    });
  }
  return merged;
}
