/**
 * Hub Protocol REST — whiteboards
 *
 * Agent-facing spatial composition surface. V1 intentionally proposes
 * placements instead of writing directly into the Yjs document: the whiteboard
 * remains the canvas/layout plane while resources keep their own source of truth.
 */

import { z } from "zod";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { db, views, eq, and, or, isNull, isNotNull } from "@synap/database";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";
import { emitBoardPlace } from "../../../services/capabilities/place-artboard-deck.js";
import {
  hasScope,
  logger,
  resolveActorId,
  verifyWorkspaceAccess,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";

const BoardPlacementOptionsSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  frameId: z.string().optional(),
  layout: z.enum(["stack", "grid", "flow", "freeform"]).optional(),
});

const BoardResourceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entity"),
    entityId: z.string().uuid(),
    entityType: z.string().nullable().optional(),
    profileId: z.string().uuid().nullable().optional(),
    title: z.string().nullable().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    status: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
  z.object({
    kind: z.literal("view"),
    viewId: z.string().uuid(),
    viewType: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("cellInstance"),
    cellInstanceId: z.string().uuid(),
    cellKey: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    title: z.string().nullable().optional(),
    defaultSize: z.object({ w: z.number(), h: z.number() }).optional(),
  }),
  z.object({
    kind: z.literal("cellDefinition"),
    cellKey: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
    defaultSize: z.object({ w: z.number(), h: z.number() }).optional(),
  }),
  z.object({
    kind: z.literal("html"),
    name: z.string().min(1),
    html: z.string(),
  }),
  z.object({
    // Multi-slide artboard deck (carousel/deck) authored by the generate_carousel
    // / generate_deck agent tools. The backend passes it through to the board's
    // socket room verbatim; the whiteboard client materializes one artboard per
    // slide. Kept in sync with the IS place-on-whiteboard union + the synap-app
    // placement handler.
    kind: z.literal("artboard-deck"),
    preset: z.string(),
    title: z.string().optional(),
    slides: z
      .array(
        z.object({
          html: z.string(),
          title: z.string().optional(),
        })
      )
      .min(1),
  }),
  z.object({
    kind: z.literal("automation"),
    automationId: z.string().uuid(),
    mode: z.enum(["flow", "detail", "status", "trigger"]),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal("url"),
    url: z.string().url(),
    title: z.string().optional(),
    embedMode: z.enum(["iframe", "link"]).optional(),
  }),
]);

const DirectPlacementBodySchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  resources: z.array(BoardResourceRefSchema).min(1),
  options: BoardPlacementOptionsSchema.optional(),
});

const ProposePlacementsBodySchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  resources: z.array(BoardResourceRefSchema).min(1),
  options: BoardPlacementOptionsSchema.optional(),
  agentUserId: z.string().uuid().optional(),
  reasoning: z.string().optional(),
  sourceMessageId: z.string().optional(),
});

export function registerWhiteboardsRoutes(app: HubHono) {
  /**
   * POST /whiteboards/:viewId/placements/propose
   *
   * Creates a governed proposal for board placements. Applying the accepted
   * proposal is handled by the proposal execution/Yjs applier path, not here.
   */
  app.post("/whiteboards/:viewId/placements/propose", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const viewId = c.req.param("viewId");
    const raw = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = ProposePlacementsBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }

    const body = parsed.data;
    // Pin to the authenticated owner — never a body-supplied userId.
    const userId = c.get("userId") as string;
    // Item 3 Part 3: confine a bound service key to its workspace. body.workspaceId
    // is a required uuid, so the `??` is a type-narrowing guard, never a widen.
    const workspaceId =
      getConfinedWorkspace(c, body.workspaceId) ?? body.workspaceId;
    if (!(await verifyWorkspaceAccess(userId, workspaceId))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }

    const ctxAgentUserId = c.get("agentUserId") as string | undefined;
    const agentUserId = body.agentUserId ?? ctxAgentUserId;
    const actorResolution = await resolveActorId(agentUserId, userId);
    if ("error" in actorResolution) {
      return c.json({ error: actorResolution.error }, 400);
    }

    try {
      const { checkPermissionOrPropose } =
        await import("../../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId,
        workspaceId,
        subjectType: "whiteboard",
        action: "place",
        // "agent" is not a valid EventSource — agent identity is on agentUserId; see SynapEventSchema
        source: "intelligence",
        data: {
          viewId,
          resources: body.resources,
          options: body.options,
          resourceCount: body.resources.length,
        },
        reasoning: body.reasoning,
        sourceMessageId: body.sourceMessageId,
      });

      if ("denied" in perm && perm.denied) {
        return c.json({ status: "denied", message: perm.reason }, 403);
      }

      if ("proposalId" in perm) {
        return c.json({
          status: "proposed",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
        });
      }

      return c.json({
        status: "accepted",
        message:
          "Whiteboard placement was allowed by governance, but direct Yjs application is not enabled for Hub REST yet.",
        viewId,
        resourceCount: body.resources.length,
      });
    } catch (err) {
      logger.error({ err, viewId }, "whiteboard placement proposal failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /whiteboards/:viewId/place
   *
   * Direct placement — emits a board:place socket event to the board's room so
   * connected whiteboard clients can place the resources immediately. No
   * governance proposal is created.
   */
  app.post("/whiteboards/:viewId/place", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const viewId = c.req.param("viewId");
    const raw = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!raw) return c.json({ error: "Invalid JSON in request body" }, 400);

    const parsed = DirectPlacementBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }

    const body = parsed.data;
    // Pin to the authenticated owner — never a body-supplied userId.
    const userId = c.get("userId") as string;
    // Item 3 Part 3: confine a bound service key to its workspace. body.workspaceId
    // is a required uuid, so the `??` is a type-narrowing guard, never a widen.
    const workspaceId =
      getConfinedWorkspace(c, body.workspaceId) ?? body.workspaceId;
    if (!(await verifyWorkspaceAccess(userId, workspaceId))) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }

    try {
      // Shared emit — the SAME function the builtin `output.generate` verb calls,
      // so the `board:place` event shape is identical across both placement paths.
      emitBoardPlace({
        viewId,
        resources: body.resources,
        options: body.options,
      });

      return c.json({
        status: "placed",
        viewId,
        resourceCount: body.resources.length,
      });
    } catch (err) {
      logger.error({ err, viewId }, "whiteboard direct placement failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /whiteboards/:viewId/state
   *
   * Returns semantic board state from what the backend knows (view metadata).
   * Live shape state is maintained in the Yjs document accessed by connected
   * clients and is not accessible server-side.
   */
  app.get("/whiteboards/:viewId/state", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const viewId = c.req.param("viewId");
    // Floor the read to the caller's visibility — the SAME predicate views.list
    // uses (isNull-personal-owned OR member/pod-visible workspace). Without it, a
    // valid hub-protocol.read key could fetch ANY view's row by id, leaking its
    // documentId (the Yjs doc handle) across tenants on an id guess.
    const userId = c.get("userId") as string;

    try {
      const view = await db.query.views.findFirst({
        where: and(
          eq(views.id, viewId),
          or(
            and(isNull(views.workspaceId), eq(views.userId, userId)),
            and(
              isNotNull(views.workspaceId),
              userVisibleWhere(views.workspaceId, userId)
            )
          )
        ),
      });

      if (!view) {
        return c.json({ error: "Whiteboard not found" }, 404);
      }

      return c.json({
        viewId: view.id,
        documentId: view.documentId ?? null,
        title: view.name ?? null,
        workspaceId: view.workspaceId ?? null,
        note: "Live shape state is maintained in the Yjs document accessed by connected clients.",
      });
    } catch (err) {
      logger.error({ err, viewId }, "whiteboard state fetch failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
