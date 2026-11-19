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
 *   projects  = WHERE THE ROW LIVES NOW, never where a caller says it is or
 *               sends it (app-permission plan 8189ae7c, W1, "the filing
 *               rule"), first match wins:
 *                 1. a FILING (`filesIntoProject`, `project.file_entities`, a
 *                    `belongs_to_project` link or relation) carries no
 *                    project: a project write never covers the
 *                    `belongs_to_project` edge; filing needs a write on the
 *                    row where it lives now;
 *                 2. `storedProjectIds`, the row's projects as the DOOR read
 *                    them from the row itself (the gate's
 *                    `grantProjectIdIsStored`);
 *                 3. the stored row named by data.id / data.entityId, read
 *                    here: an entity's `belongs_to_project` edges, a
 *                    session's or a goal's `project_id`, a project itself;
 *                 4. a CREATE: where the new row lands (the gate's projectId,
 *                    else `data.projectId`).
 *               Anything else carries no project. The gate's projectId on a
 *               non-create write is the caller's LENS or a provenance tag
 *               (the X-Project-Id header, the agent's focus, a first-row
 *               fallback), never a place. No project → a project-restricted
 *               grant fails closed.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { and, db, eq, getRequestGrant, type KeyGrant } from "@synap/database";
import {
  entities,
  focusSessions,
  profiles,
  projects,
  projectTracks,
  relations,
} from "@synap/database/schema";
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
  /**
   * This write FILES a row into a project, or takes it out of one (a
   * session's `projectId`, a record's `belongs_to_project` edge). It is
   * checked where the row lives now with NO project: a scope pinned to
   * projects never covers it, whatever it holds in them (the filing rule,
   * see the module doc).
   */
  filesIntoProject?: boolean;
  /**
   * The projects the row of this write is filed in, as the DOOR read them
   * from the stored row (a session's `project_id`, a proposal's target):
   * where it lives now. `null` = in none. Leave it out unless the door read
   * it from the row: a lens, a header or a provenance tag is never a place.
   */
  storedProjectIds?: readonly string[] | null;
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
  /** The space the refused write was in, when the producer knows it. */
  workspaceId?: string | null;
  /** The app the refused key's grant names (`KeyGrant.clientId`), if any. */
  clientId?: string | null;
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
export function recordGrantDenial(
  message: string,
  action?: string,
  where?: { workspaceId?: string | null; clientId?: string | null }
): void {
  denialSink.getStore()?.push({
    message,
    ...(action ? { action } : {}),
    ...(where?.workspaceId ? { workspaceId: where.workspaceId } : {}),
    ...(where?.clientId ? { clientId: where.clientId } : {}),
  });
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** The project-membership edge (utils/project-scope.ts `BELONGS_TO_PROJECT`). */
const BELONGS_TO_PROJECT = "belongs_to_project";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored entity's kind and the live projects it is filed in; undefined = no row. */
async function storedEntity(
  entityId: string,
  withProjects: boolean
): Promise<{ kind: string | undefined; projectIds: string[] } | undefined> {
  const [row] = await db
    .select({ slug: profiles.slug, type: entities.type })
    .from(entities)
    .leftJoin(profiles, eq(entities.profileId, profiles.id))
    .where(eq(entities.id, entityId))
    .limit(1);
  if (!row) return undefined;
  const kind = row.slug ?? row.type ?? undefined;
  if (!withProjects) return { kind, projectIds: [] };
  const filed = await db
    .select({ id: relations.targetEntityId })
    .from(relations)
    .innerJoin(projects, eq(projects.id, relations.targetEntityId))
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        eq(relations.sourceEntityId, entityId)
      )
    );
  return {
    kind,
    projectIds: [
      ...new Set(filed.map((f) => f.id).filter((id): id is string => !!id)),
    ],
  };
}

/** A stored goal's project; undefined = no row. */
async function storedTrackProject(
  trackId: string
): Promise<string | undefined> {
  if (!UUID.test(trackId)) return undefined;
  const [row] = await db
    .select({ projectId: projectTracks.projectId })
    .from(projectTracks)
    .where(eq(projectTracks.id, trackId))
    .limit(1);
  return row?.projectId ?? undefined;
}

/** Is there a project with this id? */
async function projectExists(projectId: string): Promise<boolean> {
  if (!UUID.test(projectId)) return false;
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return !!row;
}

/** A stored session's project (null = none); undefined = no row. */
async function storedSessionProject(
  sessionId: string
): Promise<string | null | undefined> {
  if (!UUID.test(sessionId)) return undefined;
  const [row] = await db
    .select({ projectId: focusSessions.projectId })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  return row ? (row.projectId ?? null) : undefined;
}

/**
 * Does this write file a row into or out of a project? `filesIntoProject`
 * from the door, the filing door itself (`project/file_entities`), or a
 * `belongs_to_project` edge written or removed as a link or a relation.
 */
export function writeFilesIntoProject(input: GrantWriteInput): boolean {
  if (input.filesIntoProject) return true;
  const data = input.data ?? {};
  if (input.subjectType === "project" && input.action === "file_entities")
    return true;
  return (
    data.linkType === BELONGS_TO_PROJECT ||
    (input.subjectType === "relation" && data.type === BELONGS_TO_PROJECT)
  );
}

/**
 * Every server-derived request a grant must permit for this write: one, or
 * two for a kind convert (the stored kind it leaves AND the kind it becomes).
 */
export async function grantRequestsForWrite(
  input: GrantWriteInput,
  /**
   * The grant it is checked against, when known: the stored row's projects
   * are read only when one of its scopes is pinned to projects (no other
   * scope looks at them).
   */
  grant?: KeyGrant
): Promise<GrantRequest[]> {
  const readsProjects =
    !grant || grant.scopes.some((scope) => !!scope.projectIds);
  const data = input.data ?? {};
  const { subject, action } = grantRequestKey(input.subjectType, input.action);
  const entityId = str(data.id) ?? str(data.entityId);
  const requestedKind = str(data.profileSlug) ?? str(data.type);
  let qualifier: string | undefined;
  let convertsTo: string | undefined;
  // Where the row lives now, read here (see the module doc): set for a
  // stored entity or session, else undefined (the door's own place).
  let storedProjectIds: string[] | null | undefined;
  if (subject === "entity") {
    const row = entityId
      ? await storedEntity(entityId, readsProjects)
      : undefined;
    const stored = row?.kind;
    qualifier = stored ?? requestedKind;
    if (stored && requestedKind && requestedKind !== stored)
      convertsTo = requestedKind;
    if (row && readsProjects)
      storedProjectIds = row.projectIds.length ? row.projectIds : null;
  } else if (subject === "session" && entityId && readsProjects) {
    const project = await storedSessionProject(entityId);
    if (project !== undefined) storedProjectIds = project ? [project] : null;
  } else if (subject === "track" && entityId && readsProjects) {
    const project = await storedTrackProject(entityId);
    if (project !== undefined) storedProjectIds = [project];
  } else if (
    subject === "project" &&
    entityId &&
    readsProjects &&
    (await projectExists(entityId))
  ) {
    storedProjectIds = [entityId];
  } else if (subject === "capability" && action === "run") {
    // Only a RUN is qualified by intent; a create/attach body's `intent` is
    // the caller's data, never the request key.
    qualifier = str(data.intent);
  } else if (subject === "event") {
    // The activity FAMILY the DOOR read off the observation's type
    // (`ci.workflow.completed` → `ci`); none → only an every-family grant.
    qualifier = str(data.family);
  }
  // Where the row lives now (the module doc's order). The gate's projectId
  // and `data.projectId` say where a NEW row lands; on any other write they
  // are a lens or where the caller sends the row, never where it is.
  const createdIn =
    action === "create"
      ? (str(input.projectId) ?? str(data.projectId))
      : undefined;
  const projectIds: string[] | null = writeFilesIntoProject(input)
    ? null
    : input.storedProjectIds !== undefined
      ? input.storedProjectIds?.length
        ? [...input.storedProjectIds]
        : null
      : storedProjectIds !== undefined
        ? storedProjectIds
        : createdIn
          ? [createdIn]
          : null;
  const req: GrantRequest = {
    subject,
    qualifier: qualifier ?? null,
    action,
    workspaceId: input.workspaceId ?? null,
    entityId: entityId ?? null,
    projectIds,
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
  for (const req of await grantRequestsForWrite(input, grant)) {
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
  recordGrantDenial(message, denied.key, {
    workspaceId: denied.workspaceId,
    clientId: grant.clientId ?? null,
  });
  return message;
}
