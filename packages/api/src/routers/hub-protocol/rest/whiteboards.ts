/**
 * Hub Protocol REST — whiteboards
 *
 * Agent-facing spatial composition surface: READ a board's content
 * (`GET /whiteboards/:viewId/scene`, `readBoardScene`) and PLACE on it
 * (`POST /whiteboards/:viewId/placements`, `placeOnBoard`). Both are the same
 * functions as MCP `synap_read_board` / `synap_place_on_board`. Resources keep
 * their own source of truth; the board holds shapes that point at them.
 */

import { db, views, eq, and } from "@synap/database";
import { ownerPrivateVisibleWhere } from "../../../utils/user-visible-where.js";
import {
  hasScope,
  logger,
  resolveActorId,
  type HubHono,
  httpStatusForTrpcError,
  requireUuidParam,
} from "./_shared.js";
import {
  BOARD_PLACE_FAILURES,
  PlaceOnBoardRequestSchema,
} from "@synap-core/types/whiteboard";
import {
  BoardPlaceError,
  placeOnBoard,
} from "../../../services/whiteboards/place-on-board.js";
import { z as zOpenapi } from "@hono/zod-openapi";
import { registerOpenApi } from "./_codecs/_register.js";
import { uuidParam } from "./_codecs/_openapi.js";
import {
  BOARD_SCENE_FAILURES,
  BoardSceneReadError,
  readBoardScene,
} from "../../../services/whiteboards/read-board-scene.js";

// ── GET /whiteboards/:viewId/scene: the documented wire ─────────────────────

const PlacedBySchema = zOpenapi.object({
  agentUserId: zOpenapi.string().optional(),
  proposalId: zOpenapi.string().optional(),
});
const ArrowEndSchema = zOpenapi.object({
  shapeId: zOpenapi.string().nullable(),
  x: zOpenapi.number().nullable(),
  y: zOpenapi.number().nullable(),
  via: zOpenapi.enum(["binding", "legacy-terminal", "point"]),
});
const BoardSceneReadSchema = zOpenapi
  .object({
    viewId: zOpenapi.string(),
    documentId: zOpenapi.string(),
    workspaceId: zOpenapi.string().nullable(),
    title: zOpenapi.string().nullable(),
    source: zOpenapi.enum(["live", "stored", "new"]),
    asOf: zOpenapi.string(),
    access: zOpenapi.enum(["read", "edit"]),
    legacyFormat: zOpenapi.literal(true).optional(),
    scene: zOpenapi.object({
      pages: zOpenapi.array(
        zOpenapi.object({
          id: zOpenapi.string(),
          name: zOpenapi.string().nullable(),
        })
      ),
      shapes: zOpenapi.array(
        zOpenapi.object({
          id: zOpenapi.string(),
          type: zOpenapi.string(),
          parentId: zOpenapi.string().nullable(),
          pageId: zOpenapi.string().nullable(),
          frameId: zOpenapi.string().nullable(),
          x: zOpenapi.number(),
          y: zOpenapi.number(),
          w: zOpenapi.number().nullable(),
          h: zOpenapi.number().nullable(),
          rotation: zOpenapi.number(),
          title: zOpenapi.string().optional(),
          text: zOpenapi.string().optional(),
          textTruncated: zOpenapi.literal(true).optional(),
          refs: zOpenapi
            .object({
              entityId: zOpenapi.string().optional(),
              entityType: zOpenapi.string().optional(),
              viewId: zOpenapi.string().optional(),
              viewType: zOpenapi.string().optional(),
              cellInstanceId: zOpenapi.string().optional(),
              cellKey: zOpenapi.string().optional(),
              url: zOpenapi.string().optional(),
            })
            .optional(),
          artboard: zOpenapi
            .object({
              presetId: zOpenapi.string().optional(),
              pageIndex: zOpenapi.number().optional(),
              outputWidth: zOpenapi.number().optional(),
              outputHeight: zOpenapi.number().optional(),
            })
            .optional(),
          placedBy: PlacedBySchema.optional(),
          pending: zOpenapi.literal(true).optional(),
        })
      ),
      arrows: zOpenapi.array(
        zOpenapi.object({
          id: zOpenapi.string(),
          parentId: zOpenapi.string().nullable(),
          pageId: zOpenapi.string().nullable(),
          frameId: zOpenapi.string().nullable(),
          start: ArrowEndSchema,
          end: ArrowEndSchema,
          text: zOpenapi.string().optional(),
          relationId: zOpenapi.string().optional(),
          graphSourced: zOpenapi.literal(true).optional(),
          placedBy: PlacedBySchema.optional(),
          pending: zOpenapi.literal(true).optional(),
        })
      ),
      counts: zOpenapi.object({
        records: zOpenapi.number(),
        shapes: zOpenapi.number(),
        arrows: zOpenapi.number(),
        byType: zOpenapi.record(zOpenapi.string(), zOpenapi.number()),
        skipped: zOpenapi.record(zOpenapi.string(), zOpenapi.number()),
      }),
      bounds: zOpenapi
        .object({
          x: zOpenapi.number(),
          y: zOpenapi.number(),
          w: zOpenapi.number(),
          h: zOpenapi.number(),
        })
        .nullable(),
      window: zOpenapi
        .object({
          frameId: zOpenapi.string().nullable(),
          offset: zOpenapi.number(),
          matched: zOpenapi.number(),
          nextOffset: zOpenapi.number().nullable(),
        })
        .optional(),
    }),
  })
  .openapi("BoardScene");
const BoardSceneQuerySchema = zOpenapi.object({
  frameId: zOpenapi.string().min(1).optional().openapi({
    description:
      "Only what this frame or artboard holds, at any depth (a shape id from the scene).",
  }),
  offset: zOpenapi.coerce.number().int().min(0).optional(),
  limit: zOpenapi.coerce.number().int().min(1).max(500).optional(),
});
const BoardSceneErrorSchema = zOpenapi.object({
  error: zOpenapi.string(),
  reason: zOpenapi
    .enum(
      Object.keys(BOARD_SCENE_FAILURES) as [
        keyof typeof BOARD_SCENE_FAILURES,
        ...Array<keyof typeof BOARD_SCENE_FAILURES>,
      ]
    )
    .optional(),
});

// ── POST /whiteboards/:viewId/placements: the documented wire ──────────────
// Parsed by `PlaceOnBoardRequestSchema` (@synap-core/types/whiteboard, the one
// contract); these schemas only document it.

const PlacementResourceDoc = zOpenapi
  .object({
    kind: zOpenapi.enum([
      "entity",
      "view",
      "cellInstance",
      "cellDefinition",
      "html",
      "artboard-deck",
      "automation",
      "url",
    ]),
  })
  .passthrough()
  .openapi({
    description:
      "One thing to place (`BoardResourceRef`): entity {entityId, title?}, view {viewId}, cellInstance {cellInstanceId}, cellDefinition {cellKey, props?}, html {name, html}, artboard-deck {preset, title?, slides:[{html, title?}]}, automation {automationId, mode}, url {url, title?}.",
  });
const PlacementRequestDoc = zOpenapi
  .object({
    resources: zOpenapi.array(PlacementResourceDoc).max(50).optional(),
    options: zOpenapi
      .object({
        x: zOpenapi.number().optional(),
        y: zOpenapi.number().optional(),
        w: zOpenapi.number().optional(),
        h: zOpenapi.number().optional(),
        frameId: zOpenapi.string().optional(),
        layout: zOpenapi.enum(["stack", "grid", "flow", "freeform"]).optional(),
      })
      .optional(),
    update: zOpenapi
      .array(
        zOpenapi.object({
          shapeId: zOpenapi.string(),
          x: zOpenapi.number().optional(),
          y: zOpenapi.number().optional(),
          w: zOpenapi.number().optional(),
          h: zOpenapi.number().optional(),
          props: zOpenapi
            .record(zOpenapi.string(), zOpenapi.unknown())
            .optional(),
        })
      )
      .max(50)
      .optional(),
    remove: zOpenapi.array(zOpenapi.string()).max(50).optional(),
    idempotencyKey: zOpenapi.string().optional(),
    workspaceId: zOpenapi.string().optional(),
    reasoning: zOpenapi.string().optional(),
    sourceMessageId: zOpenapi.string().optional(),
  })
  .openapi("BoardPlacementRequest");
const PlacementPartDoc = zOpenapi.object({
  status: zOpenapi.enum(["applied", "proposed"]),
  shapeIds: zOpenapi.array(zOpenapi.string()),
  target: zOpenapi.enum(["live", "stored"]).optional(),
  pending: zOpenapi.boolean().optional(),
  proposalId: zOpenapi.string().optional(),
  reviewUrl: zOpenapi.string().optional(),
});
const PlacementResultDoc = zOpenapi
  .object({
    viewId: zOpenapi.string(),
    documentId: zOpenapi.string(),
    workspaceId: zOpenapi.string().nullable(),
    created: PlacementPartDoc.optional(),
    updated: PlacementPartDoc.optional(),
    removed: PlacementPartDoc.optional(),
  })
  .openapi("BoardPlacementResult");
const PlacementErrorDoc = zOpenapi.object({
  error: zOpenapi.string(),
  reason: zOpenapi
    .enum(
      Object.keys(BOARD_PLACE_FAILURES) as [
        keyof typeof BOARD_PLACE_FAILURES,
        ...Array<keyof typeof BOARD_PLACE_FAILURES>,
      ]
    )
    .optional(),
});

export function registerWhiteboardsRoutes(app: HubHono) {
  registerOpenApi(app, {
    method: "get",
    path: "/whiteboards/{viewId}/scene",
    tags: ["Views"],
    summary: "What a whiteboard holds: its shapes, arrows and frames",
    description:
      "The board's content as a scene (`readBoardScene`, the same function as MCP `synap_read_board`): per shape its tldraw type, page-space bounds, parent and frame, what it references (entityId, viewId, cellInstanceId, url) and its text; arrows with the shape each end is bound to and `relationId`; artboard preset and page; `placedBy` / `pending` marks; counts and a bounding box. Read from the open room's live document when the board is open (`source: live`), else from the saved file (`stored`, which lags an open room by up to ~10 s), or empty when never saved (`new`). Readable by whoever may join the board's room. `frameId` narrows to one frame or artboard and `offset`/`limit` page the shapes (`scene.window.nextOffset`); `counts` and `bounds` always describe the whole board. A failed read is an error with a `reason`, never an empty board.",
    request: {
      params: zOpenapi.object({ viewId: uuidParam }),
      query: BoardSceneQuerySchema,
    },
    responses: {
      200: { description: "Board scene", schema: BoardSceneReadSchema },
      400: {
        description: "Not a whiteboard / bad id",
        schema: BoardSceneErrorSchema,
      },
      403: {
        description: "Missing scope or key confined elsewhere",
        schema: BoardSceneErrorSchema,
      },
      404: {
        description: "No such board, or not visible to you",
        schema: BoardSceneErrorSchema,
      },
      409: {
        description: "The board has no content document",
        schema: BoardSceneErrorSchema,
      },
      500: { description: "Internal error", schema: BoardSceneErrorSchema },
      502: {
        description: "The board's content could not be decoded",
        schema: BoardSceneErrorSchema,
      },
      503: {
        description: "The realtime server or storage did not answer",
        schema: BoardSceneErrorSchema,
      },
    },
  });

  /**
   * GET /whiteboards/:viewId/scene
   *
   * The governed READ door of a board's content (`readBoardScene`). Static
   * siblings of `/whiteboards/:viewId/*` only; no `/:id` catch-all precedes it.
   */
  app.get("/whiteboards/:viewId/scene", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const viewId = requireUuidParam(c, "viewId");
    if (viewId instanceof Response) return viewId;
    const query = BoardSceneQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json(
        { error: query.error.issues.map((i) => i.message).join(", ") },
        400
      );
    }
    const userId = c.get("userId") as string;
    try {
      const read = await readBoardScene({
        viewId,
        userId,
        confinedWorkspaceId:
          (c.get("keyWorkspaceId") as string | null | undefined) ?? null,
        window: query.data,
      });
      return c.json(read);
    } catch (err) {
      if (err instanceof BoardSceneReadError) {
        return c.json({ error: err.message, reason: err.reason }, err.status);
      }
      logger.error({ err, viewId }, "whiteboard scene read failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  registerOpenApi(app, {
    method: "post",
    path: "/whiteboards/{viewId}/placements",
    tags: ["Views"],
    summary: "Place things on a whiteboard, or change what it holds",
    description:
      "The ONE governed place door (`placeOnBoard`, the same function as MCP `synap_place_on_board`). `resources` CREATES shapes: entity cards, live views, cells, html (an html-embed cell), urls (an iframe-embed cell), automations, and artboard decks (one artboard per slide). By default they appear at once; an agent's are marked `meta.pending` (with `meta.placedBy` / `meta.placedAt`) until the person keeps or rejects them on the board. `update` (position, size, props) and `remove` change shapes already there and are proposals by default. Written into the open board (every viewer sees it) or, when nobody has it open, into its saved file. Shape ids are fixed by `idempotencyKey` (else by the request), so a retry replaces what the first call placed. Needs edit access to the board; a board of another space than `workspaceId` is not found. A refusal is an error with a `reason`; nothing is half-written.",
    request: {
      params: zOpenapi.object({ viewId: uuidParam }),
      body: PlacementRequestDoc,
    },
    responses: {
      200: {
        description: "What was placed, changed or proposed",
        schema: PlacementResultDoc,
      },
      400: {
        description: "Bad request, unknown frame or shape",
        schema: PlacementErrorDoc,
      },
      403: {
        description: "Missing scope, read-only, or denied",
        schema: PlacementErrorDoc,
      },
      404: {
        description: "No such board, or not in your space",
        schema: PlacementErrorDoc,
      },
      409: {
        description: "The board failed to load or has no document",
        schema: PlacementErrorDoc,
      },
      500: { description: "Internal error", schema: PlacementErrorDoc },
      502: {
        description: "The board or a cell could not be read or made",
        schema: PlacementErrorDoc,
      },
      503: {
        description:
          "The realtime server or storage did not answer, or the save did not land",
        schema: PlacementErrorDoc,
      },
    },
  });

  /**
   * POST /whiteboards/:viewId/placements
   *
   * THE place door (`placeOnBoard`): create shapes (governed `whiteboard/place`,
   * applied by default, pending-marked for an agent), change or remove shapes
   * (`whiteboard/update_shapes` / `whiteboard/delete_shapes`, proposals by
   * default). The board's own room floor, never the body's workspace.
   */
  app.post("/whiteboards/:viewId/placements", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const viewId = requireUuidParam(c, "viewId");
    if (viewId instanceof Response) return viewId;
    const raw = (await c.req.json().catch(() => null)) as unknown;
    if (raw === null)
      return c.json({ error: "Invalid JSON in request body" }, 400);
    const parsed = PlaceOnBoardRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join(", "),
          reason: "bad_request",
        },
        400
      );
    }
    // The acting identity comes from the verified key, never the body.
    const userId = c.get("userId") as string;
    const agentUserId = c.get("agentUserId") as string | undefined;
    const actor = await resolveActorId(agentUserId, userId);
    if ("error" in actor) return c.json({ error: actor.error }, 400);
    try {
      const result = await placeOnBoard({
        viewId,
        userId,
        agentUserId: agentUserId ?? null,
        confinedWorkspaceId:
          (c.get("keyWorkspaceId") as string | null | undefined) ?? null,
        request: parsed.data,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof BoardPlaceError) {
        return c.json({ error: err.message, reason: err.reason }, err.status);
      }
      logger.error({ err, viewId }, "whiteboard placement failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  /**
   * GET /whiteboards/:viewId/state
   *
   * Returns the board's metadata only (view row). Its CONTENT (shapes, arrows,
   * frames, from the live room or the stored file) is read through
   * `GET /whiteboards/:viewId/scene` (`readBoardScene`).
   */
  app.get("/whiteboards/:viewId/state", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const viewId = requireUuidParam(c, "viewId");
    if (viewId instanceof Response) return viewId;
    // Floor the read to the caller's visibility — the SAME predicate views.list
    // uses (isNull-personal-owned OR member/pod-visible workspace). Without it, a
    // valid hub-protocol.read key could fetch ANY view's row by id, leaking its
    // documentId (the Yjs doc handle) across tenants on an id guess.
    const userId = c.get("userId") as string;

    try {
      const view = await db.query.views.findFirst({
        where: and(
          eq(views.id, viewId),
          ownerPrivateVisibleWhere(views.workspaceId, views.userId, userId)
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
