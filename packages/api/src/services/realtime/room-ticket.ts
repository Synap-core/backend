/**
 * The room ticket door (0438, board lane wb-room; founder decisions of 18 Nov
 * 2026, session 52ce3ee9: "Apps open live rooms: Yes").
 *
 * A pod app holds its person's connection token on its own server. To open a
 * document's live Yjs room from the browser it asks this door for a TICKET:
 * 60 s, single use, bound to the person, ONE document and the most the socket
 * may do there. The `/yjs` gate claims it once and gives the socket the lesser
 * of the ticket's access and the document's floor at that moment
 * (`packages/realtime/src/yjs-server.ts`, `authorizeTicketRoomAccess`).
 *
 * The access, decided here because only this request carries the grant:
 *   read — the document's floor admits the person (`resolveDocumentRoomAccess`,
 *          the same predicate the `/yjs` gate asks) AND the connection's grant
 *          reads it: that predicate reads through `scopedDb`, which ANDs the
 *          request's grant (`grantReadPredicate`; a view-owned canvas is read
 *          through its view). A document the grant does not read is "not
 *          found", as on every narrowed door.
 *   edit — the floor says edit, the caller holds `hub-protocol.write`, and the
 *          grant permits writing that body: `document.update` on the document
 *          (its space), or, for a canvas, `view.update_content` on the view
 *          that owns it (the permission the board's REST save asks,
 *          `views.updateContent`). Otherwise read.
 * A caller may ask for less (`access: "read"`), never more.
 *
 * WHO may ask: a key held by a person (a pod app's `app_person` connection
 * token first of all). An agent never gets a live room — its writes are
 * proposals (`checkPermissionOrPropose`), and a room writes directly. A
 * signed-in person (Kratos session, Synap app device) opens the room with
 * their own token and needs no ticket. Both are refused at the route.
 */
import { db, eq, getRequestGrant, type KeyGrant } from "@synap/database";
import { documents, views } from "@synap/database/schema";
import { mintRoomTicket } from "@synap/database/realtime-room-tickets";
import { getViewCategory } from "@synap-core/types/views";
import { resolveDocumentRoomAccess } from "../../utils/document-edit-access.js";
import { grantDeniedKey } from "../../utils/grant-write-check.js";

export type RoomTicketAccess = "read" | "edit";

export interface RoomTicketRequest {
  userId: string;
  /** The connection key asking: the socket lives no longer than it. */
  apiKeyId: string;
  documentId: string;
  /** May the key write at all (`hub-protocol.write`)? */
  mayWrite: boolean;
  /** Ask for less than the most allowed. */
  access?: RoomTicketAccess;
}

export type RoomTicketResult =
  | {
      ok: true;
      ticket: string;
      expiresAt: Date;
      userId: string;
      documentId: string;
      /** `whiteboard-<id>` for a canvas document, `<id>` otherwise. */
      room: string;
      access: RoomTicketAccess;
    }
  | { ok: false; reason: "not_found" };

/** The `/yjs` room of a document of this type (`parseRoomName` in realtime). */
export function roomNameFor(documentId: string, documentType: string): string {
  return getViewCategory(documentType) === "canvas"
    ? `whiteboard-${documentId}`
    : documentId;
}

/** May this grant write the body of this document? (no grant = a person). */
async function grantWritesBody(
  grant: KeyGrant | undefined,
  doc: { id: string; workspaceId: string | null },
  canvas: boolean
): Promise<boolean> {
  if (!grant) return true;
  const asDocument = await grantDeniedKey(
    {
      subjectType: "document",
      action: "update",
      workspaceId: doc.workspaceId,
      data: { id: doc.id },
    },
    grant
  );
  if (!asDocument) return true;
  if (!canvas) return false;
  const view = await db.query.views.findFirst({
    where: eq(views.documentId, doc.id),
    columns: { id: true, workspaceId: true, projectId: true },
  });
  if (!view) return false;
  const asView = await grantDeniedKey(
    {
      subjectType: "view",
      action: "updateContent",
      workspaceId: view.workspaceId,
      projectId: view.projectId,
      data: { id: view.id },
    },
    grant
  );
  return !asView;
}

/** Issue a ticket for one document's live room, or say it is not found. */
export async function issueRoomTicket(
  req: RoomTicketRequest
): Promise<RoomTicketResult> {
  // Grant-aware: reads through scopedDb under the request's grant.
  const floor = await resolveDocumentRoomAccess(req.userId, req.documentId);
  if (floor === "none") return { ok: false, reason: "not_found" };
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, req.documentId),
    columns: { id: true, type: true, workspaceId: true },
  });
  if (!doc) return { ok: false, reason: "not_found" };
  const canvas = getViewCategory(doc.type) === "canvas";

  const access: RoomTicketAccess =
    req.access !== "read" &&
    floor === "edit" &&
    req.mayWrite &&
    (await grantWritesBody(getRequestGrant(), doc, canvas))
      ? "edit"
      : "read";

  const { ticket, expiresAt } = await mintRoomTicket(db, {
    userId: req.userId,
    documentId: doc.id,
    access,
    apiKeyId: req.apiKeyId,
  });
  return {
    ok: true,
    ticket,
    expiresAt,
    userId: req.userId,
    documentId: doc.id,
    room: roomNameFor(doc.id, doc.type),
    access,
  };
}
