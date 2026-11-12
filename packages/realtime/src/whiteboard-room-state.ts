/**
 * Server-only state of whiteboard rooms: whether the room failed to load the
 * board's saved content.
 *
 * WHY HERE AND NOT IN THE Y.DOC. A key in the shared document (the
 * `synap-room.loadError` mark document rooms use) is a value every client
 * receives, keeps (the whiteboard client persists its Y.Doc in IndexedDB) and
 * sends back. A client that once opened a failed board would carry the mark
 * into a later, HEALTHY room and fail it: its editors' strokes dropped, its
 * saves refused, its reads answered "unreadable". So the flag lives on the
 * server, keyed by the room's Y.Doc, set ONLY by `bindState` when a load fails
 * and gone with the doc when the room closes (the next open loads again).
 * Clients learn it from `yjs-access {access:"read", reason:"load-failed"}`;
 * the board read door learns it from the bridge's state reply
 * (`YjsRoomStateReply.loadFailed`).
 *
 * NO IN-ROOM RETRY (deliberate). Reloading a failed room while sockets are in
 * it is not safe: every update those sockets sent was dropped, so their later
 * updates depend on operations the server never applied and Yjs would hold
 * them pending forever (silently lost edits); forcing a resync needs a
 * server-side disconnect, which the socket.io client does not auto-reconnect.
 * The room loads again once every socket has left (y-socket.io destroys the
 * doc). A safe retry is a follow-up: it needs the client to resync on heal.
 */

import type * as Y from "yjs";
import { ROOM_META_KEYS, roomMeta } from "./document-room.js";

/** What the room says when a whiteboard's saved content failed to load. */
export const WHITEBOARD_LOAD_FAILED_MESSAGE =
  "The board's saved content could not be loaded.";

export interface WhiteboardLoadFailure {
  message: string;
  /** When the load failed (ms since epoch). */
  at: number;
}

const failedRooms = new WeakMap<Y.Doc, WhiteboardLoadFailure>();

/** Record that this room's load FAILED (only `bindState` calls it). */
export function markWhiteboardLoadFailed(
  doc: Y.Doc,
  message: string = WHITEBOARD_LOAD_FAILED_MESSAGE,
  now: number = Date.now()
): void {
  failedRooms.set(doc, { message, at: now });
}

/**
 * Did this whiteboard room fail to load? Such a room holds no board: it takes
 * no client write and is never saved over the stored file.
 */
export function whiteboardLoadFailed(doc: Y.Doc): boolean {
  return failedRooms.has(doc);
}

/** The failure, for the bridge's state reply; undefined for a loaded room. */
export function whiteboardLoadFailure(
  doc: Y.Doc
): WhiteboardLoadFailure | undefined {
  return failedRooms.get(doc);
}

/** Is this Y.Doc a whiteboard room (`whiteboard-<documentId>`)? */
export function isWhiteboardRoom(doc: Y.Doc): boolean {
  const name = (doc as Y.Doc & { name?: unknown }).name;
  return typeof name === "string" && name.startsWith("whiteboard-");
}

/**
 * Remove a `synap-room.loadError` key from a whiteboard room. The server never
 * writes it there (see above); one can only arrive from a client or from a
 * legacy `yjs:` body, and it means nothing in a whiteboard room. Removing it
 * also clears it from every client's copy as the change syncs. Document rooms
 * keep their own contract: the key is theirs.
 */
export function stripWhiteboardLoadErrorKey(doc: Y.Doc): void {
  if (!isWhiteboardRoom(doc)) return;
  const meta = roomMeta(doc);
  if (!meta.has(ROOM_META_KEYS.loadError)) return;
  doc.transact(() => meta.delete(ROOM_META_KEYS.loadError));
}
