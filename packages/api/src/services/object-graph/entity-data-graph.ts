/**
 * Entity-data graph fold — the ONE place that reads the `relations` /
 * property / channel graph (`relations.getConnections`) and maps it into the
 * uniform GraphNeighbor shape.
 *
 * Kept OUT of `graph-service.ts` (which is dependency-light + tRPC-free): this
 * read needs a tRPC caller ctx, so it lives in its own seam that both surfaces —
 * the REST `/graph` route and the MCP `synap_get_graph` / `get_entity` tools —
 * import, instead of each re-implementing the same getConnections → fold (the
 * duplication a review flagged). Best-effort: the entity-data half is additive,
 * so any failure yields [] rather than blanking the whole graph.
 */

import { createLogger } from "@synap-core/core";
import { createHubProtocolCallerContext } from "../../routers/hub-protocol/utils.js";
import { relationsRouter } from "../../routers/relations.js";
import { connectionsToNeighbors, type GraphNeighbor } from "./graph-service.js";

const logger: any = createLogger({ module: "object-graph" });

/**
 * `getConnections` is a hub-protocol procedure gated on `hub-protocol.read`. The
 * REST route already holds hub scopes, but the MCP path passes raw `mcp.*` key
 * scopes — translate them (idempotent: a Set dedups already-present hub scopes)
 * so the same shared seam works from either surface. Mirrors the translation in
 * the MCP adapter's `createHubProtocolCaller`.
 */
function toHubScopes(scopes: string[]): string[] {
  return Array.from(
    new Set([
      ...scopes,
      ...(scopes.includes("mcp.read") ? ["hub-protocol.read"] : []),
      ...(scopes.includes("mcp.write")
        ? ["hub-protocol.read", "hub-protocol.write"]
        : []),
    ])
  );
}

/**
 * The relations + property + channel neighbours of an entity, as GraphNeighbor[].
 * `workspaceId` is optional — the REST route binds one, the MCP path doesn't.
 */
export async function entityDataNeighbors(
  userId: string,
  scopes: string[],
  entityId: string,
  workspaceId?: string
): Promise<GraphNeighbor[]> {
  try {
    const ctx = await createHubProtocolCallerContext(
      userId,
      toHubScopes(scopes),
      workspaceId
    );
    const caller = relationsRouter.createCaller(
      ctx as Parameters<typeof relationsRouter.createCaller>[0]
    );
    const result = await caller.getConnections({
      entityId,
      limit: 100,
      workspaceId,
    });
    return connectionsToNeighbors(result.connections);
  } catch (err) {
    // The entity-data half is additive — a failure degrades to [] rather than
    // blanking the whole graph. But LOG it: a silent catch here once hid a scope
    // bug (mcp.* not translated) that made the agent's graph look empty.
    logger.warn(
      { err, entityId },
      "entityDataNeighbors failed — degraded to []"
    );
    return [];
  }
}
