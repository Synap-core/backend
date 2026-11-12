/**
 * readBoardScene — the ONE governed read of a whiteboard's content.
 *
 * Doors: Hub `GET /api/hub/whiteboards/:viewId/scene` and MCP
 * `synap_read_board` call this function and nothing else.
 *
 * Floor: the realtime room's own (`resolveDocumentRoomAccess`, the predicate
 * `@synap/realtime` uses to admit a socket into `whiteboard-<documentId>`):
 * `read` or `edit` reads the board, `none` is a 404. A reader of this door can
 * therefore never see more than joining the room would show them. A key bound
 * to a space reads only that space's boards.
 *
 * Source: the live Y.Doc when the room is open (realtime bridge
 * `GET /yjs/:roomId/state`, BRIDGE_SECRET-gated, 404 = room not open), else the
 * stored file at `documents.storageKey` (written by the room every ~10 s, so it
 * lags an open room; that is why the live doc answers first). A board that was
 * never saved has no file: an empty scene, `source: "new"`.
 *
 * A failed read is an ERROR with a reason code (`BoardSceneReadError`), never
 * an empty board: the bridge down, a stored file that cannot be fetched or
 * parsed. `views.get` folds a failed read into `{}`; this door does not.
 */

import * as Y from "yjs";
import { db, documents, eq, views } from "@synap/database";
import { storage } from "@synap/storage";
import { createLogger } from "@synap-core/core";
import { resolveDocumentRoomAccess } from "../../utils/document-edit-access.js";
import { bridgeRequestHeaders } from "../../utils/chat-realtime-broadcast.js";
import {
  buildBoardScene,
  windowBoardScene,
  type BoardSceneWindow,
  type BoardSceneWindowed,
} from "./board-scene.js";

const logger = createLogger({ module: "read-board-scene" });

/** How long the live read may take before it is a failure (ms). */
export const BOARD_LIVE_READ_TIMEOUT_MS = 5_000;

/**
 * Why a board could not be read. A MACHINE code (the door maps it to an HTTP
 * status and the agent reads it); never "empty".
 */
export const BOARD_SCENE_FAILURES = {
  /** No such view, or the caller may not see it (no existence oracle). */
  not_found: 404,
  /** The view is not a whiteboard. */
  not_a_board: 400,
  /** The whiteboard has no content document (never initialised). */
  not_initialized: 409,
  /** The realtime server could not be asked whether the room is open. */
  live_unavailable: 503,
  /** The room answered, but its state could not be decoded. */
  live_unreadable: 502,
  /** The stored file could not be fetched from object storage. */
  stored_unavailable: 503,
  /** The stored file was fetched but is not a tldraw store. */
  stored_unreadable: 502,
} as const;
export type BoardSceneFailure = keyof typeof BOARD_SCENE_FAILURES;

export class BoardSceneReadError extends Error {
  readonly status: (typeof BOARD_SCENE_FAILURES)[BoardSceneFailure];
  constructor(
    readonly reason: BoardSceneFailure,
    message: string
  ) {
    super(message);
    this.name = "BoardSceneReadError";
    this.status = BOARD_SCENE_FAILURES[reason];
  }
}

export interface BoardSceneRead {
  viewId: string;
  documentId: string;
  workspaceId: string | null;
  title: string | null;
  /**
   * `live` = the open room's Y.Doc; `stored` = the saved file (an open room
   * would have answered first); `new` = never saved, empty by fact.
   */
  source: "live" | "stored" | "new";
  /** ISO time the content is true as of (now for live, last save for stored). */
  asOf: string;
  /** Whether the caller may also edit the board (the room floor's answer). */
  access: "read" | "edit";
  /** A stored body in the pre-JSON `yjs:<base64>` form. */
  legacyFormat?: true;
  scene: BoardSceneWindowed;
}

export interface ReadBoardSceneInput {
  viewId: string;
  /** The person the read is for (the key's linked user). */
  userId: string;
  /** A key bound to one space reads only that space's boards. */
  confinedWorkspaceId?: string | null;
  /** Read one frame and/or one page of shapes (`windowBoardScene`). */
  window?: BoardSceneWindow;
}

function realtimeUrl(): string {
  return process.env.REALTIME_URL || "http://localhost:4001";
}

/** The records of a Y.Doc's tldraw map, from an encoded update. */
function recordsFromYjsUpdate(update: Uint8Array, documentId: string): unknown {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    return doc.getMap(`tl_map_${documentId}`).toJSON();
  } finally {
    doc.destroy();
  }
}

/**
 * The live room's records, or `null` when the room is not open (404). Any
 * other answer is a failure, never "not open": a closed bridge must not read
 * as a closed room, because the stored file lags an open one.
 */
async function readLiveRecords(
  roomId: string,
  documentId: string
): Promise<unknown | null> {
  let res: Response;
  try {
    res = await fetch(
      `${realtimeUrl()}/yjs/${encodeURIComponent(roomId)}/state`,
      {
        headers: bridgeRequestHeaders(),
        signal: AbortSignal.timeout(BOARD_LIVE_READ_TIMEOUT_MS),
      }
    );
  } catch (err) {
    logger.warn({ err, roomId }, "board live read: realtime unreachable");
    throw new BoardSceneReadError(
      "live_unavailable",
      "The realtime server did not answer, so whether the board is open is unknown. Retry shortly."
    );
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    logger.warn({ status: res.status, roomId }, "board live read refused");
    throw new BoardSceneReadError(
      "live_unavailable",
      `The realtime server answered ${res.status} for the board's room. Retry shortly.`
    );
  }
  try {
    const body = (await res.json()) as { state?: unknown };
    if (typeof body.state !== "string") throw new Error("no state");
    return recordsFromYjsUpdate(
      new Uint8Array(Buffer.from(body.state, "base64")),
      documentId
    );
  } catch (err) {
    logger.warn({ err, roomId }, "board live read: undecodable state");
    throw new BoardSceneReadError(
      "live_unreadable",
      "The open board's state could not be decoded."
    );
  }
}

/** The stored file's records, and whether it was the legacy `yjs:` form. */
async function readStoredRecords(
  storageKey: string,
  documentId: string
): Promise<{ records: unknown; legacy: boolean }> {
  let body: string;
  try {
    body = (await storage.downloadBuffer(storageKey)).toString("utf-8");
  } catch (err) {
    logger.warn({ err, documentId }, "board stored read failed");
    throw new BoardSceneReadError(
      "stored_unavailable",
      "The board's saved file could not be fetched from storage. Retry shortly."
    );
  }
  try {
    // Same two forms the realtime server loads (`yjs-server.ts` bindState).
    if (body.startsWith("yjs:")) {
      return {
        records: recordsFromYjsUpdate(
          new Uint8Array(Buffer.from(body.slice(4), "base64")),
          documentId
        ),
        legacy: true,
      };
    }
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("not an object");
    const store = (parsed as { store?: unknown }).store ?? parsed;
    if (typeof store !== "object" || store === null || Array.isArray(store))
      throw new Error("store is not an object");
    return { records: store, legacy: false };
  } catch (err) {
    logger.warn({ err, documentId }, "board stored file unreadable");
    throw new BoardSceneReadError(
      "stored_unreadable",
      "The board's saved file is not a readable board."
    );
  }
}

export async function readBoardScene(
  input: ReadBoardSceneInput
): Promise<BoardSceneRead> {
  const notFound = () =>
    new BoardSceneReadError(
      "not_found",
      "Board not found (or you cannot see it). List boards with synap_list_views."
    );

  const view = await db.query.views.findFirst({
    where: eq(views.id, input.viewId),
  });
  if (!view) throw notFound();
  if (
    input.confinedWorkspaceId &&
    view.workspaceId !== input.confinedWorkspaceId
  )
    throw notFound();

  if (!view.documentId) {
    // Say "not initialised" only to someone who may see the view.
    const { assertViewAccess } = await import("../../routers/views.js");
    try {
      await assertViewAccess(view, input.userId, "read");
    } catch {
      throw notFound();
    }
    throw new BoardSceneReadError(
      "not_initialized",
      "This view has no content document, so it holds no board."
    );
  }
  const documentId = view.documentId;

  // The room floor: the same predicate that admits a socket to the room.
  const access = await resolveDocumentRoomAccess(input.userId, documentId);
  if (access === "none") throw notFound();

  if (view.type !== "whiteboard") {
    throw new BoardSceneReadError(
      "not_a_board",
      `This view is a ${view.type}, not a whiteboard.`
    );
  }

  const base = {
    viewId: view.id,
    documentId,
    workspaceId: view.workspaceId ?? null,
    title: view.name ?? null,
    access,
  };

  const roomId = view.yjsRoomId ?? `whiteboard-${documentId}`;
  const asOfLive = new Date().toISOString();
  const live = await readLiveRecords(roomId, documentId);
  if (live !== null) {
    return {
      ...base,
      source: "live",
      asOf: asOfLive,
      scene: windowBoardScene(buildBoardScene(live), input.window ?? {}),
    };
  }

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
    columns: { storageKey: true, updatedAt: true, createdAt: true },
  });
  if (!doc) throw notFound();
  if (!doc.storageKey) {
    // Never saved: the realtime server starts such a room empty too.
    return {
      ...base,
      source: "new",
      asOf: doc.createdAt.toISOString(),
      scene: windowBoardScene(buildBoardScene({}), input.window ?? {}),
    };
  }
  const stored = await readStoredRecords(doc.storageKey, documentId);
  return {
    ...base,
    source: "stored",
    asOf: doc.updatedAt.toISOString(),
    ...(stored.legacy ? { legacyFormat: true as const } : {}),
    scene: windowBoardScene(
      buildBoardScene(stored.records),
      input.window ?? {}
    ),
  };
}
