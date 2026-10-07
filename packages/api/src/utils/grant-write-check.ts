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
 *   subject   = the gate subjectType (plural spelling folded: workspaces → workspace)
 *   qualifier = for `entity`: data.profileSlug / data.type, else the stored kind
 *               of data.id / data.entityId (profiles.slug, then entities.type)
 *   workspace = the gate's workspaceId
 *   entity    = data.id / data.entityId
 *   projects  = the gate's projectId / data.projectId (unknown → a
 *               project-restricted grant fails closed)
 */

import { db, eq, getRequestGrant, type KeyGrant } from "@synap/database";
import { entities, profiles } from "@synap/database/schema";
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

/** The server-derived request a grant is checked against. */
export async function grantRequestForWrite(
  input: GrantWriteInput
): Promise<GrantRequest> {
  const data = input.data ?? {};
  const subject =
    input.subjectType === "workspaces" ? "workspace" : input.subjectType;
  const entityId = str(data.id) ?? str(data.entityId);
  let qualifier: string | undefined;
  if (subject === "entity") {
    qualifier =
      str(data.profileSlug) ??
      str(data.type) ??
      (entityId ? await storedKind(entityId) : undefined);
  }
  const projectId = str(input.projectId) ?? str(data.projectId);
  return {
    subject,
    qualifier: qualifier ?? null,
    action: input.action,
    workspaceId: input.workspaceId ?? null,
    entityId: entityId ?? null,
    projectIds: projectId ? [projectId] : null,
  };
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
  const req = await grantRequestForWrite(input);
  // ANY one scope must permit the WHOLE request on its own — scopes never
  // combine (one scope's kind with another's workspace is the cross product).
  if (grant.scopes.some((scope) => permits(scope, req))) return null;
  const key = [req.subject, req.qualifier, req.action]
    .filter(Boolean)
    .join(".");
  return `This key's grant does not allow "${key}"${
    req.workspaceId ? ` in workspace ${req.workspaceId}` : ""
  }.`;
}
