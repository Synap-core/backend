/**
 * Hub Protocol REST — links (the config/runtime graph; mirror of `relations`).
 *
 * `relations` is the entity-DATA graph; `links` is the config/runtime graph
 * (playbook · tool · skill · command · session · source) that can ALSO point at
 * entity data — the Option-3 bridge. This endpoint is the governed write door for
 * a knowledge↔config edge, e.g. `entity(knowledge) --about--> tool`.
 *
 * Governance: gated by `hub-protocol.write` scope + `checkPermissionOrPropose`
 * (mirrors `POST /relations`) — an agent write either applies or becomes a
 * reviewable proposal.
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  resolveActorId,
  type HubHono,
} from "./_shared.js";
import {
  createLink,
  getLinksFor,
} from "../../../services/links/links-service.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import type { LinkEndpointType, LinkType } from "@synap/playbooks";
import { db, eq, and, isNull, getWorkspaceMembership } from "@synap/database";
import { workspaces } from "@synap/database/schema";

// Kept in sync with LinkEndpointType (packages/database/src/schema/links.ts).
// __tripwires__/links-endpoint-type-ssot.test.ts fails the build if this
// array ever drifts from the schema union again.
const LINK_ENDPOINT_TYPES = [
  "playbook",
  "tool",
  "skill",
  "command",
  "session",
  "source",
  "entity",
  "channel",
  "participant",
  "automation",
  "project",
  "secret",
  "capability",
  "agent",
  "workspace",
  "governance_rule",
] as const;

const LINK_TYPES = [
  "grants",
  "requires",
  "instantiated_from",
  "used",
  "targets",
  "produced",
  "member_of",
  "feeds",
  "promoted_to",
  "provided_by",
  "about",
  "documents",
  "concerns",
] as const;

const CreateLinkRequestSchema = z.object({
  userId: z.string().optional(),
  workspaceId: z.string().uuid().optional(),
  fromType: z.enum(LINK_ENDPOINT_TYPES),
  fromId: z.string().min(1),
  toType: z.enum(LINK_ENDPOINT_TYPES),
  toId: z.string().min(1),
  linkType: z.enum(LINK_TYPES),
  metadata: z.record(z.string(), z.any()).optional(),
  agentUserId: z.string().uuid().optional(),
  reasoning: z.string().optional(),
});

export function registerLinksRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/links",
    tags: ["Links"],
    summary: "Create a config/runtime link edge",
    description:
      "Creates a typed edge in the config graph (`links`) — the mirror of `relations`. Can bridge entity DATA to config objects, e.g. entity(knowledge) --about--> tool. Gated by checkPermissionOrPropose.",
    request: {
      body: CreateLinkRequestSchema,
    },
    responses: {
      200: {
        description: "Created link, or a proposal when governance defers",
        schema: z.object({ status: z.string() }).passthrough(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /links
   */
  app.post("/links", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as {
      userId?: string;
      workspaceId?: string;
      fromType?: string;
      fromId?: string;
      toType?: string;
      toId?: string;
      linkType?: string;
      metadata?: Record<string, unknown>;
      agentUserId?: string;
      reasoning?: string;
    } | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = CreateLinkRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: `Invalid link payload: ${parsed.error.message}` },
        400
      );
    }

    // Bind acting identity + workspace to the authenticated principal, and
    // membership-check the workspace (closes the IDOR — same as POST /relations).
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    // Workspace-as-endpoint edges (feeds/requires between two lenses) name a
    // SECOND workspace beyond the stamped one — membership-check it too, or
    // a member of workspace A could wire an edge exposing workspace B's
    // existence/lens without ever belonging to B.
    for (const endpointWorkspaceId of new Set(
      [
        parsed.data.fromType === "workspace" ? parsed.data.fromId : null,
        parsed.data.toType === "workspace" ? parsed.data.toId : null,
      ].filter((id): id is string => id !== null)
    )) {
      const [endpointWorkspace, endpointMembership] = await Promise.all([
        db.query.workspaces.findFirst({
          where: and(
            eq(workspaces.id, endpointWorkspaceId),
            isNull(workspaces.archivedAt)
          ),
          columns: { id: true },
        }),
        getWorkspaceMembership(db, endpointWorkspaceId, userId),
      ]);
      if (!endpointWorkspace || !endpointMembership) {
        return c.json(
          { error: `Access denied to workspace ${endpointWorkspaceId}` },
          403
        );
      }
    }

    try {
      const actorResolution = await resolveActorId(body.agentUserId, userId);
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;

      // Governance: apply directly OR generate a reviewable proposal.
      const perm = await checkPermissionOrPropose({
        userId: actorId,
        workspaceId,
        subjectType: "link",
        action: "create",
        data: {
          // Human title so the proposal inbox shows a meaningful label
          // (e.g. "entity --about--> tool") instead of "Untitled".
          title: `${parsed.data.fromType} --${parsed.data.linkType}--> ${parsed.data.toType}`,
          fromType: parsed.data.fromType,
          fromId: parsed.data.fromId,
          toType: parsed.data.toType,
          toId: parsed.data.toId,
          linkType: parsed.data.linkType,
        },
      });
      if ("denied" in perm && perm.denied) {
        return c.json({ error: perm.reason }, 403);
      }
      if ("proposalId" in perm) {
        return c.json({ status: "proposed", proposalId: perm.proposalId });
      }

      const created = await createLink({
        workspaceId,
        fromType: parsed.data.fromType as LinkEndpointType,
        fromId: parsed.data.fromId,
        toType: parsed.data.toType as LinkEndpointType,
        toId: parsed.data.toId,
        linkType: parsed.data.linkType as LinkType,
        metadata: parsed.data.metadata,
      });

      return c.json({ status: "created", link: created ?? null });
    } catch (err) {
      logger.error({ err }, "createLink failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  registerOpenApi(app, {
    method: "get",
    path: "/links",
    tags: ["Links"],
    summary: "Read a node's links (neighbours in the config/runtime graph)",
    description:
      "Returns every edge touching (type, id) — the REST mirror of the canonical getLinksFor reader. Lets any agent/app traverse the graph (tool↔vault, skill↔tool, session↔used→tool, playbook→grants→capability) uniformly. Scoped to the caller's visible workspaces.",
    request: {
      query: z.object({
        type: z.enum(LINK_ENDPOINT_TYPES),
        id: z.string().min(1),
      }),
    },
    responses: {
      200: {
        description: "The edges touching this node",
        schema: z.object({ links: z.array(z.record(z.string(), z.any())) }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /links?type=&id= — neighbour read. The canonical getLinksFor reader,
   * exposed over REST so external agents/cells can traverse the graph the same
   * way the tRPC `playbooks.links.getFor` does for the frontend.
   */
  app.get("/links", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const type = c.req.query("type");
    const id = c.req.query("id");
    if (
      !type ||
      !id ||
      !(LINK_ENDPOINT_TYPES as readonly string[]).includes(type)
    ) {
      return c.json(
        {
          error:
            "Query params `type` (a link endpoint type) and `id` are required",
        },
        400
      );
    }
    // Bind acting identity to the authenticated principal (workspace scoping is
    // applied inside getLinksFor via userVisibleWhere).
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const links = await getLinksFor(
        acting.userId,
        type as LinkEndpointType,
        id
      );
      return c.json({ links });
    } catch (err) {
      logger.error({ err }, "getLinksFor failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
