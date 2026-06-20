/**
 * Hub Protocol REST — /graph (graph by default).
 *
 * `GET /graph/:type/:id` — fetch ANY object PLUS its typed neighbourhood in one
 * call. The uniform read envelope over Synap's two edge graphs: `links`
 * (config/runtime, all kinds) + `relations`/property/channel (entity data). The
 * same shape for entity / view / channel / session / playbook / tool / skill /
 * automation / project / document, so an agent (or the UI) never fetches a thing
 * without seeing where it sits in the pod.
 *
 * The config half (links) is served by the dependency-light object-graph service.
 * The entity-data half reuses `relations.getConnections` (held here because it
 * needs the tRPC ctx) and is folded in via `connectionsToNeighbors`.
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import {
  getObjectGraph,
  type GraphNeighbor,
} from "../../../services/object-graph/graph-service.js";
import { entityDataNeighbors } from "../../../services/object-graph/entity-data-graph.js";
import type { LinkEndpointType } from "@synap/playbooks";

// Kinds the envelope can focus on. Superset of LinkEndpointType so entity-data
// kinds (view, document) are addressable too — they hydrate via the registry.
const GRAPH_KINDS = [
  "entity",
  "project",
  "view",
  "channel",
  "session",
  "playbook",
  "tool",
  "skill",
  "automation",
  "document",
  "command",
  "source",
  "participant",
] as const;

// Entity-backed kinds carry the relations/property/channel data graph on top of
// their links graph — fold in getConnections for these.
const ENTITY_BACKED = new Set(["entity", "project"]);

const GraphNodeSchema = z
  .object({
    kind: z.string(),
    id: z.string(),
    name: z.string(),
    subtype: z.string().nullable(),
    workspaceId: z.string().nullable(),
  })
  .openapi("GraphNode");

const GraphNeighborSchema = GraphNodeSchema.extend({
  edgeType: z.string(),
  direction: z.enum(["outgoing", "incoming", "structural"]),
  via: z.enum(["links", "relations", "property", "channel"]),
}).openapi("GraphNeighbor");

const GraphEnvelopeSchema = z
  .object({
    object: GraphNodeSchema,
    neighbors: z.array(GraphNeighborSchema),
    counts: z.object({
      total: z.number(),
      byKind: z.record(z.string(), z.number()),
      byVia: z.record(z.string(), z.number()),
    }),
  })
  .openapi("GraphEnvelope");

export function registerGraphRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/graph/{type}/{id}",
    tags: ["System"],
    summary: "Fetch an object + its typed neighbour graph",
    description:
      "Returns ANY object (entity, view, channel, session, playbook, tool, skill, automation, project, document) " +
      "plus everything it is linked to — typed as { kind, subtype, name } per neighbour, across the config (links) " +
      "and data (relations/property/channel) graphs. Graph by default: never fetch a thing without its place in the pod.",
    responses: {
      200: { description: "Graph envelope", schema: GraphEnvelopeSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/graph/:type/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const type = c.req.param("type");
    const id = c.req.param("id");
    if (!type || !id) return c.json({ error: "type and id are required" }, 400);
    if (!(GRAPH_KINDS as readonly string[]).includes(type)) {
      return c.json(
        {
          error: `Unknown object kind '${type}'. One of: ${GRAPH_KINDS.join(", ")}`,
        },
        400
      );
    }

    // Bind to the authenticated principal — never read another user's graph.
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    try {
      // Entity-data half (relations + property + channel) — only for
      // entity-backed kinds, via the shared getConnections fold.
      let extra: GraphNeighbor[] = [];
      if (ENTITY_BACKED.has(type)) {
        extra = await entityDataNeighbors(
          userId,
          c.get("scopes") as string[],
          id,
          workspaceId ?? undefined
        );
      }

      const envelope = await getObjectGraph(
        userId,
        type as LinkEndpointType,
        id,
        extra
      );
      return c.json(envelope, 200);
    } catch (err) {
      logger.error({ err, type, id }, "graph fetch failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
