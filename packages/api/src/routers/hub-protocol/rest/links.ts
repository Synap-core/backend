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
import { jsonGoverned } from "../proposal-response.js";
import {
  createLink,
  getLinksFor,
} from "../../../services/links/links-service.js";
import {
  addSessionBlocker,
  validateSessionBlocker,
} from "../../../services/focus-sessions/session-blocked-by.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { linkProjectToWorkspace } from "../../../utils/project-workspace.js";
import type { LinkEndpointType, LinkType } from "@synap/playbooks";
import { db } from "@synap/database";
import { checkLinkEndpointsVisible } from "./link-endpoint-visibility.js";

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
  "document",
] as const;

/**
 * Endpoint types this door READS but never WRITES. A `document --produced-->
 * entity` edge asserts "this raw capture made that entity" — only the
 * materialization record (`stampMaterialized`) knows that, after checking the
 * document belongs to the receipt's owner. An agent-written one would be a
 * provenance claim nobody verified.
 */
const SYSTEM_WRITTEN_ENDPOINT_TYPES: ReadonlySet<string> = new Set([
  "document",
]);

/**
 * The link types an agent may WRITE over the Hub Protocol.
 *
 * This is the schema `LinkType` union MINUS members that nothing produces and
 * nothing reads — not an independent list. `__tripwires__/links-type-ssot.test.ts`
 * DERIVES both halves (the union from the schema, the live set from the
 * producers/readers in source) so this array cannot drift again in either
 * direction: land a producer and the tripwire demands the member here; delete
 * the last producer and it demands the member go.
 *
 * The four that were missing, and why three of them are now here:
 *   - `blocked_by`   — producer + reader in `session-blocked-by.ts`. Without it
 *                      an IS agent, which reaches the pod ONLY through Hub
 *                      Protocol, could never declare that one unit of work
 *                      blocks another — a first-class primitive it is expected
 *                      to use.
 *   - `spawned_from` — producer + reader in `@synap/database`'s
 *                      `session-spawn.ts` (work lineage).
 *   - `activates`    — producer in `playbooks.ts` / `services/rules`, reader in
 *                      `services/rules` (automation → playbook).
 *
 * `provides_credential` is deliberately NOT here. Migration 0161 RETIRED it —
 * it folded every such edge onto its target secret and then `DELETE FROM links
 * WHERE link_type = 'provides_credential'`; dynamic tool auth now lives on the
 * secrets connection registry (see `routers/tools.ts`, which says so in as many
 * words). It has ZERO producers and ZERO readers in TypeScript. Allowlisting it
 * for symmetry would let an agent create edges nothing can interpret — the very
 * defect the `governance_rule` removal recorded one level up, in the endpoint
 * union. It stays out until a producer lands.
 */
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
  "activates",
  "spawned_from",
  "blocked_by",
  "uses",
] as const;

/**
 * Refusals from the `blocked_by` floor. `not_found` is 404 for BOTH a missing
 * session and one owned by someone else: the floor cannot tell them apart, and
 * a 403 for "exists but not yours" would turn this door into an existence
 * oracle for other users' session ids.
 */
const BLOCKER_REFUSALS = {
  self_blocker: { status: 400, error: "A session cannot be blocked by itself" },
  not_found: { status: 404, error: "Session not found" },
} as const;

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
        description:
          "Created link, or a proposal when governance defers. For `blocked_by`, `link` is always null (there is no row to hand back through the dedicated producer) and `blockedBy.inserted` distinguishes a new edge (1) from an already-existing one (0).",
        schema: z.object({ status: z.string() }).passthrough(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Session not found", schema: ErrorSchema },
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
    if (
      SYSTEM_WRITTEN_ENDPOINT_TYPES.has(parsed.data.fromType) ||
      SYSTEM_WRITTEN_ENDPOINT_TYPES.has(parsed.data.toType)
    ) {
      return c.json(
        {
          error:
            "document links are written by the pod when a capture is structured; they cannot be created here",
        },
        400
      );
    }

    // Bind acting identity + workspace to the authenticated principal, and
    // membership-check the workspace (closes the IDOR — same as POST /relations).
    const acting = await resolveActingContext(c, body);
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;

    // `blocked_by` has a dedicated producer (`addSessionBlocker`) whose floor —
    // session endpoints, no self-edge, BOTH sessions owned by the caller — is
    // what makes its owner-blind readers safe. A raw edge from this door would
    // let an agent point its session at a stranger's and have the unblock
    // reactor notify it with the stranger's session title. Validate BEFORE
    // governance, or an invalid edge becomes a proposal that approval writes.
    const isBlockedBy = parsed.data.linkType === "blocked_by";
    // The BLOCKED session's own workspace — what the edge will be stamped
    // with (via `addSessionBlocker`) and the workspace governance must judge
    // in, so a filed proposal's `workspaceId` always matches the edge it
    // would create. Populated below only for `blocked_by`.
    let blockedByWorkspaceId: string | null = null;
    if (isBlockedBy) {
      if (
        parsed.data.fromType !== "session" ||
        parsed.data.toType !== "session"
      ) {
        return c.json(
          { error: "blocked_by links must connect two sessions" },
          400
        );
      }
      // `addSessionBlocker` always writes `metadata: {}` — no real caller
      // (IS, CLI, browser) sends metadata with blocked_by today, so refusing
      // it is not a behaviour cut; forwarding it would need a producer change
      // outside this door, and silently dropping it is not an option.
      if (parsed.data.metadata !== undefined) {
        return c.json(
          { error: "blocked_by links do not support metadata" },
          400
        );
      }
    }

    if (
      parsed.data.linkType === "uses" &&
      (parsed.data.fromType !== "project" || parsed.data.toType !== "workspace")
    ) {
      return c.json(
        {
          error:
            "uses links must be project --uses--> workspace (the INDEX door)",
        },
        400
      );
    }

    // EVERY endpoint must be an object the caller can see, BEFORE governance —
    // otherwise an invisible id becomes a proposal (a name oracle on read-back,
    // and an edge approval would write). One canonical read floor per type;
    // an invisible and a nonexistent id get the identical refusal. This also
    // covers what used to be inline here: a workspace endpoint's membership
    // (a member of A must not wire an edge naming B) and the `uses` project.
    const endpointRefusal = await checkLinkEndpointsVisible(
      parsed.data,
      userId,
      workspaceId ?? null
    );
    if (endpointRefusal) {
      return c.json({ error: endpointRefusal.error }, endpointRefusal.status);
    }

    if (isBlockedBy) {
      const valid = await validateSessionBlocker({
        sessionId: parsed.data.fromId,
        blockerSessionId: parsed.data.toId,
        userId,
      });
      if (!valid.ok) {
        const refusal = BLOCKER_REFUSALS[valid.reason];
        return c.json({ error: refusal.error }, refusal.status);
      }
      blockedByWorkspaceId = valid.workspaceId;
    }

    try {
      // Falls back to the key's own bound agent identity when the body omits
      // `agentUserId` — mirrors `runs.ts`. Without it, a `hub_inbound` key
      // that leaves `agentUserId` out of the body is governed as the human
      // instead of the agent it authenticated as.
      const agentUserId =
        body.agentUserId ?? (c.get("agentUserId") as string | undefined);
      const actorResolution = await resolveActorId(agentUserId, userId);
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;

      // `userId` must stay the acting human (`proposals.subjectUserId`'s
      // source — see `applyApprovedBlockedBy`); `actorId` goes in `agentUserId`
      // only when it differs, mirroring `runs.ts`. For `blocked_by`, judge in
      // the BLOCKED session's workspace so a filed proposal matches the edge.
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: actorId !== userId ? actorId : undefined,
        workspaceId: isBlockedBy ? blockedByWorkspaceId : workspaceId,
        subjectType: "link",
        action: "create",
        ...(typeof body.reasoning === "string" && body.reasoning.trim()
          ? { reasoning: body.reasoning.trim() }
          : {}),
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
        return jsonGoverned(c, {
          status: "proposed",
          proposalId: perm.proposalId,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
        });
      }

      const isUsesIndex = parsed.data.linkType === "uses";

      if (isBlockedBy) {
        // `addSessionBlocker` derives the edge's workspace itself from the
        // blocked session's own row — the same source `blockedByWorkspaceId`
        // above was read from, so this is a re-validation at write time
        // (ownership may have shifted), never a second, independent source.
        // `from --blocked_by--> to` ≡ addBlocker(sessionId: from, blocker: to).
        const result = await addSessionBlocker({
          sessionId: parsed.data.fromId,
          blockerSessionId: parsed.data.toId,
          userId,
        });
        if (!result.linked) {
          const refusal = BLOCKER_REFUSALS[result.reason];
          return c.json({ error: refusal.error }, refusal.status);
        }
        // `link` is always null — there is no row to hand back through the
        // dedicated producer; `blockedBy.inserted` (1 = new edge, 0 = already
        // existed) distinguishes this from the generic door's shape.
        return c.json({
          status: "created" as const,
          link: null,
          blockedBy: { inserted: result.inserted },
        });
      }

      if (isUsesIndex) {
        const uses = await linkProjectToWorkspace(db, {
          projectId: parsed.data.fromId,
          workspaceId: parsed.data.toId,
          userId,
        });
        if (!uses.linked) {
          const message =
            uses.reason === "workspace_not_found"
              ? "Workspace not found"
              : "Project not found";
          return c.json({ error: message }, 404);
        }
        return c.json({
          status: "created",
          link: null,
          uses: { indexed: true },
        });
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
