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

import { createHubProtocolCallerContext } from "../../routers/hub-protocol/utils.js";
import { relationsRouter } from "../../routers/relations.js";
import { connectionsToNeighbors, type GraphNeighbor } from "./graph-service.js";

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
      scopes,
      workspaceId
    );
    const caller = relationsRouter.createCaller(
      ctx as Parameters<typeof relationsRouter.createCaller>[0]
    );
    const result = await caller.getConnections({ entityId, limit: 100 });
    return connectionsToNeighbors(result.connections);
  } catch {
    // entity-data half is additive — never let it blank the graph
    return [];
  }
}
