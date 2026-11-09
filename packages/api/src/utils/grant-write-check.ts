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
 *               For a `capability` RUN: data.intent, the intent the DOOR
 *               read off the verb it resolved (`capability.publish_post.run`);
 *               a run with no intent (the raw provider proxy) has none, so
 *               only a grant on every intent permits it.
 *               For `event`: data.family, the observation namespace the
 *               door read off its type (`event.ci.create`).
 *   workspace = the gate's workspaceId
 *   entity    = data.id / data.entityId
 *   projects  = the gate's projectId / data.projectId (unknown → a
 *               project-restricted grant fails closed)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { db, eq, getRequestGrant, type KeyGrant } from "@synap/database";
import { entities, profiles } from "@synap/database/schema";
import { grantRequestKey, grantRequestKeys } from "@synap/governance-policy";
import {
  patternMatches,
  permits,
  type GrantRequest,
} from "@synap/governance-policy/grants";
import { placeBeyondPodWideReads } from "@synap-core/types/grants";

export interface GrantWriteInput {
  subjectType: string;
  action: string;
  workspaceId?: string | null;
  projectId?: string | null;
  data?: Record<string, unknown> | null;
  /**
   * A NAMED permission that also permits this write (`namedPermissionPermits`):
   * the door's own act, asked for by name, when the gate's subject/action is
   * broader than what the person consented to. Set by the template-apply
   * filing (`package.install`, services/template-apply/propose.ts).
   */
  namedPermission?: NamedGrantPermission;
}

/** A door's named permission (`<subject>.<action>`) and the space it lands in. */
export interface NamedGrantPermission {
  subject: string;
  action: string;
  /** The space the write lands in; null = it makes a new one. */
  workspaceId: string | null;
}

/**
 * Does one scope hold the named permission for this write? Only a pattern
 * that NAMES the subject counts (`package.install`, `package.*`), never a bare
 * `*`: a key pinned to one space with `*` was never asked about this act. The
 * scope's space pin holds when the write lands in a space it names; a write
 * that makes a NEW space has none to check, so the pin cannot narrow it (the
 * person ticked the permission in the spaces they gave, and an app's grant is
 * always pinned). A scope pinned to projects or objects never holds it (fail
 * closed: a new space belongs to neither).
 */
export function namedPermissionPermits(
  grant: KeyGrant,
  named: NamedGrantPermission
): boolean {
  return grant.scopes.some((scope) => {
    if (scope.projectIds || scope.entityIds) return false;
    const holds = scope.permissions.some(
      (p) =>
        p.split(".")[0] === named.subject &&
        patternMatches(p, { subject: named.subject, action: named.action })
    );
    if (!holds) return false;
    // Where the scope reaches for a write, read through the ONE parse
    // (access model B, `packages/types/src/grants/reach.ts`).
    const place = placeBeyondPodWideReads(scope);
    if (!place) return false;
    if (place.kind === "unbounded" || named.workspaceId === null) return true;
    return place.ids.includes(named.workspaceId);
  });
}

/**
 * The machine-readable code of a write refused by the key's grant. A client
 * reads it (and `action`) instead of matching the sentence: Hub REST adds both
 * to every 403 that carries a denial this module produced
 * (`hub-protocol/_middleware/grant-denial-code.ts`).
 */
export const GRANT_DENIED = "GRANT_DENIED" as const;

/** One grant denial produced during a request: its words and the refused action. */
export interface GrantDenialRecord {
  /** The request key the grant did not allow, e.g. `workspace.update`, when named. */
  action?: string;
  /** The exact sentence `grantWriteDenial` returned. */
  message: string;
}

const denialSink = new AsyncLocalStorage<GrantDenialRecord[]>();

/**
 * Run `fn` collecting every grant denial `grantWriteDenial` produces under it
 * into `sink`. Entered once per Hub REST request, so the door's 403 can carry
 * the structured code without any route re-deriving it from its words.
 */
export function runCollectingGrantDenials<T>(
  sink: GrantDenialRecord[],
  fn: () => T
): T {
  return denialSink.run(sink, fn);
}

/**
 * Record a grant denial worded outside `grantWriteDenial` (a door's own
 * sentence for the same refusal), so its 403 carries the code too.
 */
export function recordGrantDenial(message: string, action?: string): void {
  denialSink.getStore()?.push({ message, ...(action ? { action } : {}) });
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
  } else if (subject === "capability" && action === "run") {
    // Only a RUN is qualified by intent; a create/attach body's `intent` is
    // the caller's data, never the request key.
    qualifier = str(data.intent);
  } else if (subject === "event") {
    // The activity FAMILY the DOOR read off the observation's type
    // (`ci.workflow.completed` → `ci`); none → only an every-family grant.
    qualifier = str(data.family);
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
 * The first request key the grant does not permit for this write, or null
 * when it permits every one (the named permission, then each request). Pure:
 * it records nothing, so a door may ASK before it decides (`grantWriteDenial`
 * is the one that refuses).
 */
export async function grantDeniedKey(
  input: GrantWriteInput,
  grant: KeyGrant
): Promise<{ key: string; workspaceId: string | null } | null> {
  if (
    input.namedPermission &&
    namedPermissionPermits(grant, input.namedPermission)
  )
    return null;
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
    return {
      key: [req.subject, req.qualifier, req.action].filter(Boolean).join("."),
      workspaceId: req.workspaceId ?? null,
    };
  }
  return null;
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
  const denied = await grantDeniedKey(input, grant);
  if (!denied) return null;
  const message = `This key's grant does not allow "${denied.key}"${
    denied.workspaceId ? ` in workspace ${denied.workspaceId}` : ""
  }.`;
  recordGrantDenial(message, denied.key);
  return message;
}
