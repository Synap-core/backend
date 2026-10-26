/**
 * W1 — the write half of grant enforcement.
 *
 * Called at the top of `checkPermissionOrPropose` (the one governed-write gate
 * every AI mutation already passes). When the request carries a grant
 * (`getRequestGrant`, entered by the three key-auth doors), the write must be
 * PERMITTED by it, or it is DENIED — never turned into a proposal: a reviewer
 * approving a write the key was never allowed to make would widen the grant.
 *
 * The request key is derived HERE, server-side, from the gate's own
 * subject/action plus the object's kind — a caller never names it:
 *   subject   = the gate subjectType, action = the gate action, both folded
 *               to the grant grammar's spelling by governance-policy
 *               `grantRequestKey` (focus_session → session, relationDef →
 *               relation_def, updateContent → update_content) — the same fold
 *               the read hook and the agent capability rung use; a door that
 *               folds (`transition` → update) is also permitted by a pattern
 *               naming it (`grantRequestKeys`)
 *   qualifier = for `entity`: the STORED kind of data.id / data.entityId
 *               (profiles.slug, then entities.type) whenever that row exists —
 *               never the caller's data.profileSlug, which on an update is the
 *               kind it converts TO (S7). A create (no row yet) uses
 *               data.profileSlug / data.type. A kind CONVERT (stored kind ≠
 *               data.profileSlug) must ALSO be permitted on the target kind.
 *   workspace = the gate's workspaceId
 *   entity    = data.id / data.entityId
 *   projects  = the gate's projectId / data.projectId (unknown → a
 *               project-restricted grant fails closed)
 */

import {
  and,
  db,
  eq,
  getRequestGrant,
  isNull,
  podSharedFacetForSpacesWhere,
  type KeyGrant,
} from "@synap/database";
import { entities, entityFacets, profiles } from "@synap/database/schema";
import { grantRequestKey, grantRequestKeys } from "@synap/governance-policy";
import { permits, type GrantRequest } from "@synap/governance-policy/grants";

export interface GrantWriteInput {
  subjectType: string;
  action: string;
  workspaceId?: string | null;
  projectId?: string | null;
  data?: Record<string, unknown> | null;
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

async function storedKind(entityId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ slug: profiles.slug, type: entities.type })
    .from(entities)
    .leftJoin(profiles, eq(entities.profileId, profiles.id))
    .where(eq(entities.id, entityId))
    .limit(1);
  return row?.slug ?? row?.type ?? undefined;
}

/**
 * Every server-derived request a grant must permit for this write: one, or
 * two for a kind convert (the stored kind it leaves AND the kind it becomes).
 */
export async function grantRequestsForWrite(
  input: GrantWriteInput
): Promise<GrantRequest[]> {
  const data = input.data ?? {};
  const { subject, action } = grantRequestKey(input.subjectType, input.action);
  const entityId = str(data.id) ?? str(data.entityId);
  const requestedKind = str(data.profileSlug) ?? str(data.type);
  let qualifier: string | undefined;
  let convertsTo: string | undefined;
  if (subject === "entity") {
    const stored = entityId ? await storedKind(entityId) : undefined;
    qualifier = stored ?? requestedKind;
    if (stored && requestedKind && requestedKind !== stored)
      convertsTo = requestedKind;
  }
  const projectId = str(input.projectId) ?? str(data.projectId);
  const req: GrantRequest = {
    subject,
    qualifier: qualifier ?? null,
    action,
    workspaceId: input.workspaceId ?? null,
    entityId: entityId ?? null,
    projectIds: projectId ? [projectId] : null,
  };
  return convertsTo ? [req, { ...req, qualifier: convertsTo }] : [req];
}

/** The server-derived request a grant is checked against (the stored kind's). */
export async function grantRequestForWrite(
  input: GrantWriteInput
): Promise<GrantRequest> {
  return (await grantRequestsForWrite(input))[0];
}

/**
 * null when the write may proceed (no grant, or the grant permits it); a
 * denial reason otherwise. `grant` defaults to the request's ambient grant.
 */
export async function grantWriteDenial(
  input: GrantWriteInput,
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<string | null> {
  if (!grant) return null;
  // A door folded onto another action (`entity/transition` → update) is also
  // permitted by a pattern naming the door itself (`grantRequestKeys`).
  const actions = grantRequestKeys(input.subjectType, input.action).map(
    (k) => k.action
  );
  for (const req of await grantRequestsForWrite(input)) {
    // ANY one scope must permit the WHOLE request on its own — scopes never
    // combine (one scope's kind with another's workspace is the cross product).
    if (
      grant.scopes.some((scope) =>
        actions.some((action) => permits(scope, { ...req, action }))
      )
    )
      continue;
    const key = [req.subject, req.qualifier, req.action]
      .filter(Boolean)
      .join(".");
    return `This key's grant does not allow "${key}"${
      req.workspaceId ? ` in workspace ${req.workspaceId}` : ""
    }.`;
  }
  return null;
}

/**
 * The space a key's grant is checked in for a write on a role facet the key
 * REACHES — writes follow the read reach (founder "option 1", 2026-10-23;
 * status moves, founder decision 1, 2026-10-26): a LIVE, POD-WIDE facet on a
 * live POD-WIDE entity whose role is granted to one of the key's spaces (THE
 * predicate the reads use, `podSharedFacetForSpacesWhere`, as in the facets
 * `spaceReach` of access/grant-read.ts). Returns the first such space, in the
 * grant's order, whose grant permits `input` there; null otherwise, and the
 * write stays pod scope (a space-pinned key fails closed, D2). Only ever the
 * facet's own write: the entity row itself is never re-placed by it.
 */
export async function reachedFacetGrantSpace(
  facetId: string,
  input: Omit<GrantWriteInput, "workspaceId">,
  grant: KeyGrant | undefined = getRequestGrant()
): Promise<string | null> {
  if (!grant) return null;
  const spaces = [
    ...new Set(grant.scopes.flatMap((scope) => scope.workspaceIds ?? [])),
  ];
  for (const space of spaces) {
    const [reached] = await db
      .select({ id: entityFacets.id })
      .from(entityFacets)
      .innerJoin(entities, eq(entities.id, entityFacets.entityId))
      .where(
        and(
          eq(entityFacets.id, facetId),
          isNull(entityFacets.deletedAt),
          podSharedFacetForSpacesWhere([space]),
          isNull(entities.workspaceId),
          isNull(entities.deletedAt)
        )
      )
      .limit(1);
    if (
      reached &&
      (await grantWriteDenial({ ...input, workspaceId: space }, grant)) === null
    )
      return space;
  }
  return null;
}
