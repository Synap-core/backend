/**
 * W1 — the door fence for SCOPED keys.
 *
 * A grant is enforced on reads by two seams (scopedDb, accessScopeWhere) and on
 * writes by the governed-write gate. The 2026-10-06 inventory found 101
 * key-reachable READ doors that read through neither seam, so a grant would
 * not bound them. Until each is migrated, a key whose grant is not the
 * explicit full-access `*` may only READ through doors known to be seamed;
 * every other read door answers 403 GRANT_DOOR_UNSUPPORTED. Fail closed: a
 * new read door is refused until someone verifies it and lists it here.
 *
 * Writes stay open: each one passes the gate, whose rung 0 denies an
 * out-of-grant write.
 *
 * P2b — an AGGREGATE read door (ask, orient, find, …) cannot narrow its
 * results row by row yet, so it DECLARES the grant subjects it reads
 * (`READS`). A fenced key passes it when one of its scopes reads EVERY
 * declared subject with no narrowing (every kind, every workspace, project
 * and object) — then the grant would remove no row the door returns, so the
 * door is bounded by it exactly. A door read through the seams is `SEAMED`.
 * Every MCP read tool must be classified (`__tripwires__/
 * grant-door-classification.tripwire.test.ts` derives the set from the live
 * tool list); an unclassified one stays refused.
 *
 * Inventory + migration order: CONNECT-RESEARCH/13-w1-grants-design-2026-10-06.md.
 */

import { isFullAccessGrant, type KeyGrant } from "@synap/database";
import {
  allowedQualifiers,
  patternMatches,
  QUALIFIED_GRANT_SUBJECTS,
  type GrantScope,
} from "@synap/governance-policy/grants";

/** How a fenced read door is bounded by a grant. */
export type FencedReadDoor =
  | { readonly bound: "seamed" }
  | { readonly bound: "reads"; readonly subjects: readonly string[] }
  | { readonly bound: "refused"; readonly reason: string };

const SEAMED: FencedReadDoor = { bound: "seamed" };
const READS = (...subjects: string[]): FencedReadDoor => ({
  bound: "reads",
  subjects,
});
const REFUSED = (reason: string): FencedReadDoor => ({
  bound: "refused",
  reason,
});

/** Does ONE scope read `subject` everywhere (every kind, no narrowing)? */
function scopeReadsUnbounded(scope: GrantScope, subject: string): boolean {
  if (scope.workspaceIds || scope.projectIds || scope.entityIds) return false;
  if ((QUALIFIED_GRANT_SUBJECTS as readonly string[]).includes(subject))
    return allowedQualifiers(scope, subject, "read") === "all";
  return scope.permissions.some((p) =>
    patternMatches(p, { subject, action: "read" })
  );
}

/** Is a key bounded on this door by its grant? */
export function grantBoundsDoor(
  door: FencedReadDoor | undefined,
  grant: KeyGrant
): boolean {
  if (!door || door.bound === "refused") return false;
  if (door.bound === "seamed") return true;
  // A deny-all scope (`permissions: []`) reads nothing — `every` over a door
  // that declares no subject would otherwise let it through.
  return grant.scopes.some(
    (scope) =>
      scope.permissions.length > 0 &&
      door.subjects.every((s) => scopeReadsUnbounded(scope, s))
  );
}

/** A grant that bounds nothing beyond the human floor needs no fence. */
export function isFencedGrant(grant: KeyGrant | null | undefined): boolean {
  return Boolean(grant) && !isFullAccessGrant(grant!);
}

/** Hub REST GET routes that read only through a seam (relative to /api/hub). */
export const GRANT_SAFE_REST_READS: readonly RegExp[] = [
  // Self-introspection: the caller's own identity and key, from the request
  // context — no row a grant bounds. Every key must be able to ask "who am I"
  // (the CLI's agent installers do, right after a device-flow approval).
  /^\/users\/me\/?$/,
  /^\/auth\/status\/?$/,
  /^\/users\/[^/]+\/entities\/?$/,
  // The list door. Every branch reads through `entities.getEntities` (the
  // seamed `entities.list` floor) EXCEPT full-text `q` (Typesense), which the
  // route itself refuses for a fenced grant (rest/entities.ts).
  /^\/entities\/?$/,
  /^\/entities\/[^/]+\/?$/,
  /^\/entities\/[^/]+\/connections\/?$/,
  /^\/entities\/[^/]+\/facets\/?$/,
  /^\/documents\/[^/]+\/?$/,
  /^\/documents\/[^/]+\/raw\/?$/,
  /^\/relations\/?$/,
  /^\/projects\/[^/]+\/outputs\/?$/,
  /^\/tracks\/?$/,
  /^\/tracks\/[^/]+\/?$/,
  /^\/artifacts\/?$/,
  /^\/commands\/?$/,
  /^\/commands\/[^/]+\/?$/,
  /^\/brand\/kit\/?$/,
  // Read only through the grant-aware channel / session helpers
  // (utils/channel-visibility.ts, access/session-visibility.ts):
  /^\/channels\/?$/,
  /^\/threads\/?$/,
  /^\/threads\/[^/]+\/messages\/?$/,
  /^\/threads\/[^/]+\/branches\/?$/,
  /^\/messaging\/channels\/?$/,
  /^\/messaging\/linked-unread\/?$/,
  /^\/focus-sessions\/?$/,
  // Read only through ownerPrivateVisibleWhere (grant hook, `project` subject)
  // plus seamed entity reads:
  /^\/projects\/?$/,
  /^\/projects\/[^/]+\/?$/,
  /^\/projects\/[^/]+\/digest\/?$/,
  // The caller's own webhook subscriptions: a key lists only those it
  // created (S2) — no row a grant bounds.
  /^\/webhooks\/?$/,
  /^\/views\/?$/, // hub views.listViews: owner + grantReadPredicate(views)
  /^\/proposals\/?$/, // hub proposals.listProposals: proposalUserFloor (+ grant)
];

/**
 * Hub REST POST routes that READ (every other POST is a write, bounded by the
 * gate). Matched in order; the first match classifies the route.
 */
export const GRANT_REST_POST_READS: ReadonlyArray<
  readonly [RegExp, FencedReadDoor]
> = [
  [
    /^\/knowledge\/(search|ask|answer)\/?$/,
    READS(
      "entity",
      "document",
      "relation",
      "proposal",
      "preference",
      "project"
    ),
  ],
  [/^\/entities\/retrieve\/?$/, READS("entity", "document", "relation")],
  [/^\/memory\/search\/?$/, READS("entity", "preference")],
  [/^\/diagnose\/?$/, REFUSED("Pod internals across every subject.")],
  [
    /^\/capabilities\/execute\/?$/,
    REFUSED("Runs arbitrary capability code: its reads cannot be declared."),
  ],
];

/**
 * Every MCP READ tool (`readOnlyHint: true`), classified. The tripwire derives
 * the live read-tool set and fails on an unclassified or stale entry.
 */
export const MCP_READ_TOOL_DOORS: Readonly<Record<string, FencedReadDoor>> = {
  synap_get_entities: SEAMED,
  synap_get_document: SEAMED,
  synap_get_relations: SEAMED,
  synap_list_tracks: SEAMED,
  synap_resolve_identity: SEAMED,
  synap_get_project: SEAMED,
  synap_list_projects: SEAMED,
  synap_list_views: SEAMED,
  // Aggregate doors: the subjects they read.
  synap_ask: READS(
    "entity",
    "document",
    "relation",
    "proposal",
    "preference",
    "project"
  ),
  synap_orient: READS("entity", "project", "session", "proposal", "track"),
  synap_find: READS("tool", "command", "playbook", "automation"),
  synap_get_entity: READS("entity", "relation", "facet", "document"),
  synap_get_graph: READS(
    "entity",
    "relation",
    "link",
    "document",
    "session",
    "project"
  ),
  synap_list_profiles: READS("entity"),
  synap_list_workspaces: READS("entity", "project"),
  synap_get_thread_context: READS("channel", "entity", "document"),
  synap_list_proposals: READS("proposal", "entity"),
  synap_get_proposal: READS("proposal", "entity"),
  synap_list_sessions: READS("session", "project"),
  synap_get_session: READS(
    "session",
    "channel",
    "proposal",
    "document",
    "entity"
  ),
  synap_revert_session: READS("session", "proposal"),
  synap_list_playbooks: READS("playbook"),
  synap_match_playbooks: READS("playbook"),
  synap_list_capabilities: READS("tool", "command", "playbook", "automation"),
  synap_list_automations: READS("automation"),
  synap_list_widgets: READS("widget", "view"),
  synap_template_health: READS("tool", "playbook", "automation", "view"),
  synap_governance: READS("proposal", "agent", "tool"),
  // The roster of agents (+ their computers and dispatch tool) for hand-off.
  synap_list_agents: READS("agent", "tool"),
  synap_export_project_pack: READS(
    "project",
    "entity",
    "document",
    "relation",
    "playbook",
    "view",
    "track"
  ),
  // Skills have no read subject in the read hook (system + the person's own
  // runbooks): any key that holds a live permission may load one.
  synap_load_skill: READS(),
  synap_diagnose: REFUSED("Pod internals across every subject."),
};

/** tRPC QUERIES (by procedure path) that read only through a seam. */
export const GRANT_SAFE_TRPC_QUERIES: ReadonlySet<string> = new Set([
  "entities.getEntities",
  "documents.getDocument",
  "relations.listRelations",
  "relations.listRelationsPodWide",
  "automations.listRuns",
  "automations.getRun",
  "commands.listCommands",
  "commands.getCommand",
  "views.listViews",
  "proposals.listProposals",
]);

export const GRANT_DOOR_UNSUPPORTED =
  "This door does not support scoped keys yet: its reads are not bounded by a grant. Use a door listed in the API keys guide, or a key with the full-access '*' grant.";

/**
 * Hub REST doors (every method, relative to /api/hub) whose EFFECT spans the
 * whole owner and that no grant can narrow — so neither the fence's "writes
 * are bounded by the gate" rule nor a workspace/project/object pin applies.
 *
 *  - `/webhooks/:id/<anything>` (the delivery log): read by owner only
 *    (tRPC `deliveries`), not by the subscription's key. `/webhooks` and
 *    `/webhooks/:id` themselves are NOT owner-wide since S2/D7 (2026-10-20):
 *    a key's subscription is bound to that key (it lists / deletes only its
 *    own, `rest/webhooks.ts`) and delivers only what the key's grant reads
 *    while the key lives (`utils/webhook-delivery.ts`, jobs
 *    `webhook-worker.ts`). Creating one still needs `hub-protocol.write`.
 *  - `/calendar/feed` (+ `/rotate`): mints a bearer URL whose `.ics` read
 *    carries NO key and so no grant — it serves every calendar entity the
 *    person can read (`calendar-feed.ts` `loadOwnedCalendarEntities`), every
 *    workspace. The credentialless `/calendar/feed/<token>.ics` read is not
 *    matched (it skips auth; no grant reaches it).
 *  - `/agents/sync`: rewrites the pod's agent roster for an intelligence
 *    service and creates agent users owned by the pod owner — direct writes,
 *    no gate. Its caller is the IS's `is_internal` key (full, unbounded `*`).
 *
 * Only a key whose grant is UNBOUNDED full access (`*`, no narrowing) may use
 * them. Note this is stricter than `isFencedGrant`: a `*` scope pinned to one
 * workspace is not fenced there (`isFullAccessGrant` reads permissions only),
 * but it is refused here.
 */
export const GRANT_OWNER_WIDE_REST_DOORS: readonly RegExp[] = [
  /^\/webhooks\/[^/]+\/.+$/,
  /^\/calendar\/feed(?:\/rotate)?\/?$/,
  /^\/agents\/sync\/?$/,
];

/**
 * Owner-wide WRITES (non-GET/HEAD only — the same paths carry reads the generic
 * fence already rules on). Each handler writes directly, never passes the
 * gate, and its effect is not narrowed by any grant (lane/sec-w3, 2026-10-19):
 *
 *  - `/capabilities/:id/credentials[/:id]` POST/PATCH/DELETE: the credential
 *    row is the owner's for EVERY workspace (`workspaceId: null`); a pod-wide
 *    one needs pod admin but no grant check.
 *  - `DELETE /vault/secrets/:id`: any secret the person can write, in any
 *    workspace (`assertWorkspaceWrite`, no grant). `POST /vault/secrets` is
 *    NOT here — agents are meant to store credentials they hold (its
 *    docblock); that is a product decision. `/vault/secrets/:id/grant` is
 *    gated (`checkPermissionOrPropose` → `grantWriteDenial`).
 *  - `DELETE /connectors/connections/:id`, `POST /connectors/disconnect`:
 *    revokes the account at the provider and detaches it from every
 *    capability (`detachNangoConnectionRegistry`).
 *
 * Callers checked: the IS (unbounded keys), the browser/app (tRPC session),
 * the CLI cap flows (reach these only after a fenced read, so only with an
 * unbounded key today). No narrowed-grant caller works today.
 */
export const GRANT_OWNER_WIDE_REST_WRITES: readonly RegExp[] = [
  /^\/capabilities\/[^/]+\/credentials(?:\/[^/]+)?\/?$/,
  /^\/vault\/secrets\/[^/]+\/?$/,
  /^\/connectors\/connections\/[^/]+\/?$/,
  /^\/connectors\/disconnect\/?$/,
];

export const GRANT_OWNER_WIDE_UNSUPPORTED =
  "This door acts on everything you own (it cannot be limited to a space, project or kind), so it needs a key with unrestricted full access ('*' with no space, project or object limit).";

/** Every scope is `*` and none is narrowed to a workspace, project or object. */
export function isUnboundedFullAccess(grant: KeyGrant): boolean {
  return (
    isFullAccessGrant(grant) &&
    grant.scopes.every((s) => !s.workspaceIds && !s.projectIds && !s.entityIds)
  );
}

/**
 * Hub REST: may a key holding `grant` use an owner-wide door? `true` for any
 * path that is not one, and for a request with no grant (a signed-in session).
 * `method` selects the write-only class (`GRANT_OWNER_WIDE_REST_WRITES`); when
 * omitted the request is treated as a write (fail closed).
 */
export function ownerWideDoorAllowed(
  path: string,
  grant: KeyGrant | null | undefined,
  method?: string
): boolean {
  if (!grant) return true;
  const m = method?.toUpperCase();
  const isRead = m === "GET" || m === "HEAD";
  const ownerWide =
    GRANT_OWNER_WIDE_REST_DOORS.some((r) => r.test(path)) ||
    (!isRead && GRANT_OWNER_WIDE_REST_WRITES.some((r) => r.test(path)));
  if (!ownerWide) return true;
  return isUnboundedFullAccess(grant);
}

/** Hub REST: may a scoped key use `method path` (path relative to /api/hub)? */
export function restDoorAllowed(
  method: string,
  path: string,
  grant: KeyGrant
): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD")
    return GRANT_SAFE_REST_READS.some((r) => r.test(path));
  if (m === "POST") {
    const read = GRANT_REST_POST_READS.find(([r]) => r.test(path));
    return !read || grantBoundsDoor(read[1], grant);
  }
  return true; // PUT / PATCH / DELETE — writes, bounded by the gate
}

/** MCP: may a scoped key call this tool? Unknown tools → let MCP answer. */
export function mcpToolAllowed(
  toolName: string,
  readOnly: boolean | undefined,
  grant: KeyGrant
): boolean {
  return (
    readOnly !== true || grantBoundsDoor(MCP_READ_TOOL_DOORS[toolName], grant)
  );
}

/** tRPC: may a scoped key call this procedure? */
export function trpcProcedureAllowed(type: string, path: string): boolean {
  return type !== "query" || GRANT_SAFE_TRPC_QUERIES.has(path);
}
