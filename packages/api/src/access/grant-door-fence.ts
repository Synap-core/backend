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
 * Writes on Hub REST and MCP stay open: each one is meant to pass the gate,
 * whose rung 0 denies an out-of-grant write. On the Bearer tRPC door (S7,
 * 2026-10-20) a mutation passes only when `TRPC_KEY_MUTATION_DOORS` says the
 * gate really bounds it; every other one needs an unbounded `*` key.
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

/**
 * A grant that bounds nothing beyond the human floor needs no fence. ANY limit
 * counts as narrowing — a `*` pinned to a space, project or object is fenced
 * like any scoped key (S1, 2026-10-20; `isFullAccessGrant` sees the pin).
 */
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
 * them — exactly the keys `isFencedGrant` does not fence (S1: a pinned `*` is
 * fenced, so it is refused here too).
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
 *    NOT here — agents store credentials they hold, bounded by the key's
 *    grant (`secret.create` in the row's workspace, S4; the AI preset holds
 *    it). `/vault/secrets/:id/grant` is gated (`checkPermissionOrPropose` →
 *    `grantWriteDenial`).
 *  - `DELETE /connectors/connections/:id`, `POST /connectors/disconnect`:
 *    revokes the account at the provider and detaches it from every
 *    capability (`detachNangoConnectionRegistry`).
 *  - `/memory` writes (`POST /memory`, `/memory/turns|sessions|writes`,
 *    `DELETE /memory/:id`; S5 2026-10-20): `knowledge_facts` about the
 *    person, recalled in EVERY workspace, written directly — no grant narrows
 *    them. `POST /memory/search` is a read (GRANT_REST_POST_READS). Agents
 *    remember a fact through MCP `synap_remember_fact` (a governed write).
 *  - `PUT` / `DELETE /knowledge/:key` (S6 2026-10-20): rewrite or archive a
 *    pod-wide `knowledge_keys` runbook BY KEY — no owner check, recalled by
 *    every agent everywhere. `/knowledge/(search|ask|answer)` are reads;
 *    `POST /knowledge` (create) is governed (`checkPermissionOrPropose`).
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
  /^\/memory(?:\/(?!search\/?$)[^/]+)?\/?$/,
  /^\/knowledge\/(?!(?:search|ask|answer)\/?$)[^/]+\/?$/,
];

export const GRANT_OWNER_WIDE_UNSUPPORTED =
  "This door acts on everything you own (it cannot be limited to a space, project or kind), so it needs a key with unrestricted full access ('*' with no space, project or object limit).";

/**
 * Every scope is `*` and none is narrowed to a workspace, project or object.
 * Since S1 this IS `isFullAccessGrant` (the one predicate); the name stays for
 * the owner-wide doors that read as "unbounded".
 */
export function isUnboundedFullAccess(grant: KeyGrant): boolean {
  return isFullAccessGrant(grant);
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

/**
 * How a key-reachable tRPC MUTATION is bounded by a grant (S7).
 *
 *  - `gated`: every write reaches the governed-write gate with the REAL
 *    target (stored row or validated input) and nothing is written before
 *    it, so rung 0 (`grantWriteDenial`) bounds it by the key's grant.
 *  - `owner_wide`: acts for the whole owner; no grant can narrow it.
 *  - `refused`: the gate does not bound it yet (gates a workspace the caller
 *    picked, writes before the gate, or no grant check at all), or it waits
 *    on a product decision. Refused for a scoped key until fixed / decided.
 */
export type TrpcWriteDoor =
  | { readonly bound: "gated" }
  | { readonly bound: "owner_wide"; readonly reason: string }
  | { readonly bound: "refused"; readonly reason: string };

const GATED: TrpcWriteDoor = { bound: "gated" };
const OWNER_WIDE = (reason: string): TrpcWriteDoor => ({
  bound: "owner_wide",
  reason,
});

/**
 * Every key-reachable tRPC MUTATION, by procedure path: the hub router
 * (`/api/hub/trpc`) and the core-router procedures built on
 * `apiKeyMiddleware`. The set is DERIVED from the live routers by
 * `__tripwires__/trpc-mutation-classification.tripwire.test.ts`; an
 * unclassified mutation is refused for every scoped key (fail closed).
 *
 * Plan + evidence (file:line per row):
 * lanes/wf-w1/_docs/13-trpc-mutation-fence-plan.md §1.2 / §2. A `refused` row
 * moves to `gated` only with its root fix (W2) and a test proving the gate
 * sees the real target.
 */
export const TRPC_KEY_MUTATION_DOORS: Readonly<Record<string, TrpcWriteDoor>> =
  {
    // (a) GATED — the gate bounds them with the grant.
    "channels.createExternalChannel": GATED,
    "skills.createSkill": GATED,
    "views.updateView": GATED,
    "views.arrangeBento": GATED,
    "views.updateContent": GATED,
    "widgetDefinitions.upsertWidgetDef": GATED,
    "automations.pauseAutomation": GATED,
    "automations.deleteAutomation": GATED,
    "signals.classify": GATED, // writes nothing
    "playbooks.promote": GATED,
    "playbooks.update": GATED,
    "entities.deleteEntity": GATED,
    "documents.createDocument": GATED,
    "documents.patchDocument": GATED,
    "documents.createDocumentProposal": GATED,
    "branches.createBranch": GATED,
    "branches.mergeBranch": GATED,
    "relationDefs.create": GATED,
    "n8nActions.analyzeContent": GATED, // writes nothing

    // (c)/(d) → GATED by their W2 root fix: the gate now sees the REAL target.
    // Each group is proven through the real Bearer door on PGlite by the test
    // named beside it.
    // W2a — routers/hub-protocol/gate-on-target.entities.pglite.test.ts
    "entities.createEntity": GATED,
    "entities.updateEntities": GATED,
    "entities.updateEntity": GATED,
    // W2a — routers/hub-protocol/gate-on-target.schema.pglite.test.ts
    "relations.createRelation": GATED,
    "relations.deleteRelation": GATED,
    "profiles.createProfile": GATED,
    "profiles.setRenderer": GATED,
    "profiles.createPropertyDef": GATED,
    "profiles.updatePropertyDef": GATED,
    // D2 (founder 2026-10-20): the parent's workspace; a pod-wide role is pod
    // scope — routers/hub-protocol/gate-on-target.schema.pglite.test.ts
    "entities.attachFacet": GATED,
    "entities.updateFacet": GATED,
    "entities.detachFacet": GATED,
    // W2b — every channel/session/memory write passes `assertChannelWrite` on
    // the CHANNEL's workspace (D4: an AI turn is a message.create there) —
    // routers/hub-protocol/gate-on-target.channels.pglite.test.ts
    "channels.resolveOrCreateChannel": GATED,
    "channels.bindChannel": GATED,
    "channels.sendExternalMessage": GATED,
    "channels.postToA2AIChannel": GATED,
    "channels.triggerAI": GATED,
    "context.updateThreadContext": GATED,
    "sessions.getOrCreate": GATED,
    "sessions.update": GATED,
    "sessions.close": GATED,
    "compactedStates.create": GATED,
    // W2c — the rest of class (c): linking returns the proposal instead of
    // inserting; the pre-gate writes (pod-wide view, session document) are
    // grant-checked; propertyDefs.create is gated (migration.migrate's last
    // ungated sub-write); signals check the grant and the relay route —
    // routers/hub-protocol/gate-on-target.misc.pglite.test.ts
    "linking.linkEntity": GATED,
    "linking.linkDocument": GATED,
    "views.createView": GATED,
    "documents.upsertSessionSection": GATED,
    "migration.migrate": GATED,
    "signals.fetch": GATED,
    "signals.subscriptions": GATED,
    "signals.batch": GATED,
    "signals.capture": GATED,
    "n8nActions.createEntity": GATED,

    // (b) OWNER-WIDE — need an unbounded `*` key.
    "channels.ensurePersonal": OWNER_WIDE(
      "The owner's pod-wide personal channel; ignores the workspace."
    ),
    "services.register": OWNER_WIDE(
      "Rewrites a pod-global intelligence service (pod admin / is_internal)."
    ),
    "intelligenceRegistry.storeServiceSecret": OWNER_WIDE(
      "Upserts the key principal's vault secret for a free-form serviceId; no gate."
    ),

    // (c) REFUSED until the W2 root fix — none left: W2a–W2c fixed every one
    // and flipped it to GATED above. A new refused row needs its reason.

    // (d) PRODUCT DECISIONS (founder 2026-10-20, plan §2 D1–D5), applied in
    // W2d — routers/hub-protocol/gate-on-target.decisions.pglite.test.ts.
    // D1: arming/running a flow is owner authority — a person's key needs
    // unbounded `*` inside the door; an agent key keeps its proposal path.
    "automations.createAutomation": GATED,
    "automations.updateAutomation": GATED,
    "automations.activateAutomation": GATED,
    "automations.triggerAutomation": GATED,
    // D3: revising honours the key's space / project / object pins.
    "proposals.updateProposal": GATED,
    // D5: an observation is `event.create` where it lands; never widened.
    "observations.append": GATED,
  };

export const GRANT_WRITE_DOOR_UNSUPPORTED =
  "This door does not support scoped keys yet: its writes are not bounded by a grant. Use a door listed in the API keys guide, or a key with unrestricted full access ('*' with no space, project or object limit).";

/**
 * tRPC (the Bearer door): may a key holding `grant` call this procedure?
 *
 *  - no grant (legacy key, session): always — unchanged;
 *  - query: an unfenced key always; a scoped key only a seamed one;
 *  - anything else (mutation, subscription): a `gated` mutation for any
 *    grant (rung 0 bounds it); owner-wide, refused AND unclassified ones only
 *    for an unbounded `*` key (a pinned `*` is scoped — S1).
 */
export function trpcProcedureAllowed(
  type: string,
  path: string,
  grant: KeyGrant | null | undefined
): boolean {
  if (!grant) return true;
  if (type === "query")
    return !isFencedGrant(grant) || GRANT_SAFE_TRPC_QUERIES.has(path);
  if (TRPC_KEY_MUTATION_DOORS[path]?.bound === "gated") return true;
  return isUnboundedFullAccess(grant);
}

/** The 403 message for a procedure `trpcProcedureAllowed` refused. */
export function trpcRefusalMessage(type: string, path: string): string {
  if (type === "query") return GRANT_DOOR_UNSUPPORTED;
  return TRPC_KEY_MUTATION_DOORS[path]?.bound === "owner_wide"
    ? GRANT_OWNER_WIDE_UNSUPPORTED
    : GRANT_WRITE_DOOR_UNSUPPORTED;
}
