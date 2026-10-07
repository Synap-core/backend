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
 * Inventory + migration order: CONNECT-RESEARCH/13-w1-grants-design-2026-10-06.md.
 */

import { isFullAccessGrant, type KeyGrant } from "@synap/database";

/** A grant that bounds nothing beyond the human floor needs no fence. */
export function isFencedGrant(grant: KeyGrant | null | undefined): boolean {
  return Boolean(grant) && !isFullAccessGrant(grant!);
}

/** Hub REST GET routes that read only through a seam (relative to /api/hub). */
export const GRANT_SAFE_REST_READS: readonly RegExp[] = [
  /^\/users\/[^/]+\/entities\/?$/,
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
  /^\/views\/?$/, // hub views.listViews: owner + grantReadPredicate(views)
  /^\/proposals\/?$/, // hub proposals.listProposals: proposalUserFloor (+ grant)
];

/** Hub REST POST routes that READ without a seam (refused for scoped keys). */
export const GRANT_UNSAFE_REST_POST_READS: readonly RegExp[] = [
  /^\/knowledge\/(search|ask|answer)\/?$/,
  /^\/entities\/retrieve\/?$/,
  /^\/memory\/search\/?$/,
  /^\/diagnose\/?$/,
  /^\/capabilities\/execute\/?$/,
];

/** MCP read-only tools that read only through a seam. */
export const GRANT_SAFE_MCP_READ_TOOLS: ReadonlySet<string> = new Set([
  "synap_get_entities",
  "synap_get_document",
  "synap_get_relations",
  "synap_list_tracks",
  "synap_resolve_identity",
  "synap_get_project",
  "synap_list_projects",
  "synap_list_views",
]);

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

/** Hub REST: may a scoped key use `method path` (path relative to /api/hub)? */
export function restDoorAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD")
    return GRANT_SAFE_REST_READS.some((r) => r.test(path));
  if (m === "POST")
    return !GRANT_UNSAFE_REST_POST_READS.some((r) => r.test(path));
  return true; // PUT / PATCH / DELETE — writes, bounded by the gate
}

/** MCP: may a scoped key call this tool? Unknown tools → let MCP answer. */
export function mcpToolAllowed(
  toolName: string,
  readOnly: boolean | undefined
): boolean {
  return readOnly !== true || GRANT_SAFE_MCP_READ_TOOLS.has(toolName);
}

/** tRPC: may a scoped key call this procedure? */
export function trpcProcedureAllowed(type: string, path: string): boolean {
  return type !== "query" || GRANT_SAFE_TRPC_QUERIES.has(path);
}
