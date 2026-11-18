/**
 * Hub Protocol REST — realtime room tickets (0432, board lane wb-room).
 *
 *   POST /realtime/room-ticket {documentId, access?}
 *
 * A pod app's connection token (held on the app's server) is traded for a
 * short-lived, single-use ticket its browser hands to the `/yjs` handshake as
 * `token`, beside `userId`. The access (read | edit) is decided from the
 * connection's grant on that document; the rules and who may ask are in
 * `services/realtime/room-ticket.ts`. A read: it writes no pod data (the
 * ticket row is the only row), classified in the grant-door fence
 * (`GRANT_REST_POST_READS`, SEAMED: the document is read through scopedDb
 * under the key's grant).
 */
import { z as zOpenapi } from "@hono/zod-openapi";
import { ErrorSchema, uuidParam } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

const RoomTicketBodySchema = zOpenapi.object({
  documentId: uuidParam,
  /** Ask for a read-only ticket even when editing is allowed. */
  access: zOpenapi.enum(["read", "edit"]).optional(),
});

const RoomTicketResponseSchema = zOpenapi.object({
  ticket: zOpenapi.string(),
  expiresAt: zOpenapi.string(),
  userId: zOpenapi.string(),
  documentId: zOpenapi.string(),
  room: zOpenapi.string(),
  access: zOpenapi.enum(["read", "edit"]),
});

export function registerRealtimeRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/realtime/room-ticket",
    tags: ["Documents"],
    summary: "Get a ticket to open one document's live room",
    description:
      "For a pod app's connection token (a key held by a person): answers a " +
      "single-use ticket, valid 60 seconds, for ONE document's live Yjs room. " +
      "The browser connects to the pod's Socket.IO server (path `/socket.io/`, " +
      "namespace `/yjs|<room>`) with handshake auth `{ userId, token: ticket }`; " +
      "a reconnect needs a new ticket. `access` is `edit` when the person may " +
      "edit the document, the key holds hub-protocol.write and its grant " +
      "permits `document.update` on it (or `view.update_content` on the view " +
      "that owns a canvas); otherwise `read`, and a read socket's updates are " +
      "dropped. Send `access: \"read\"` to ask for less. The socket closes when " +
      "the app's connection is revoked. A document the person or the grant " +
      "cannot read is 404. Refused (403) to an agent and to a signed-in " +
      "session, which opens the room with its own token. Requires " +
      "hub-protocol.read.",
    request: { body: RoomTicketBodySchema },
    responses: {
      200: { description: "The ticket", schema: RoomTicketResponseSchema },
      400: { description: "Invalid body", schema: ErrorSchema },
      403: { description: "Not a person's key", schema: ErrorSchema },
      404: { description: "No such document", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/realtime/room-ticket", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string | undefined;
    const apiKeyId = c.get("apiKeyId") as string | undefined;
    if (!userId) return c.json({ error: "Unauthenticated" }, 403);
    if (c.get("agentUserId")) {
      return c.json(
        {
          error:
            "An agent cannot open a live room: its changes go through proposals.",
          code: "ROOM_TICKET_AGENT",
        },
        403
      );
    }
    if (!apiKeyId) {
      return c.json(
        {
          error:
            "A room ticket is for an app's connection token. A signed-in session opens the room with its own token.",
          code: "ROOM_TICKET_NOT_A_KEY",
        },
        403
      );
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    const body = RoomTicketBodySchema.safeParse(raw);
    if (!body.success) {
      return c.json(
        { error: "Invalid body", details: body.error.flatten() },
        400
      );
    }
    try {
      const { issueRoomTicket } =
        await import("../../../services/realtime/room-ticket.js");
      const out = await issueRoomTicket({
        userId,
        apiKeyId,
        documentId: body.data.documentId,
        mayWrite: hasScope(c.get("scopes") as string[], "hub-protocol.write"),
        access: body.data.access,
      });
      if (!out.ok) return c.json({ error: "Document not found" }, 404);
      logger.info(
        {
          documentId: out.documentId,
          access: out.access,
          apiKeyId,
          userId,
        },
        "realtime room ticket issued"
      );
      return c.json({
        ticket: out.ticket,
        expiresAt: out.expiresAt.toISOString(),
        userId: out.userId,
        documentId: out.documentId,
        room: out.room,
        access: out.access,
      });
    } catch (err) {
      logger.error(
        { err, userId, documentId: body.data.documentId },
        "POST /realtime/room-ticket failed"
      );
      return c.json({ error: "The room ticket could not be issued" }, 500);
    }
  });
}
