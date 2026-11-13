/**
 * Socket.IO Bridge - HTTP Endpoint for Inngest Workers
 *
 * Allows Inngest workers (running in separate process) to emit events
 * to Socket.IO clients via HTTP POST requests.
 *
 * Workers POST to /bridge/emit → Socket.IO emits to connected clients
 */

import type { Server as SocketIOServer } from "socket.io";
import type { IncomingMessage, ServerResponse } from "http";
import * as Y from "yjs";
import { safeTokenEqual } from "@synap/auth";
// The payload contract lives with the schemas (dedicated subpath, so the
// bridge doesn't pull in `@synap/events`' boss/db side-effects, which require
// DATABASE_URL): the pod's emitters test their payloads against this same
// function.
import {
  validateEmitPayload,
  YJS_APPLY_FAILURES,
  type YjsApplyFailure,
  type YjsRoomApplyError,
  type YjsRoomApplyReply,
  type YjsRoomApplyRequest,
  type YjsRoomStateReply,
} from "@synap/events/realtime-schemas";
import { whiteboardLoadFailure } from "./whiteboard-room-state.js";
export {
  validateEmitPayload,
  type ValidateEmitResult,
} from "@synap/events/realtime-schemas";

interface BridgeEmitRequest {
  event: string;
  workspaceId?: string;
  viewId?: string;
  userId?: string;
  /** Channel-scoped room — reduces noise by targeting only clients in that channel */
  channelId?: string;
  data: any;
}

/** Lazy getter for the Yjs server — set after yjsServer is initialized in server.ts */
type YjsServerAccessor = () => {
  documents: Map<string, Y.Doc>;
  applyWhiteboardRecords?: (
    roomName: string,
    request: YjsRoomApplyRequest
  ) => Promise<YjsRoomApplyReply>;
} | null;
let getYjsServer: YjsServerAccessor = () => null;

/** Track last successful MinIO/DB write for /health/yjs */
let lastPersistAt: Date | null = null;
/** Track last upload failure for /health/yjs — a non-null value means the durable layer is degraded */
let lastPersistFailureAt: Date | null = null;
let persistFailureCount = 0;
const serverStartAt = new Date();

export function recordYjsPersist(): void {
  lastPersistAt = new Date();
}

/** Call when ALL MinIO upload attempts fail so the failure is observable via /health/yjs */
export function recordYjsPersistFailure(): void {
  lastPersistFailureAt = new Date();
  persistFailureCount += 1;
}

/** The Socket.IO request path (server.ts `path`, shared by /presence and /yjs). */
const SOCKET_IO_PATH = "/socket.io/";

/**
 * Who answers an HTTP request to the realtime port: the bridge (its own
 * endpoints and the health checks), Socket.IO (its path), or nobody (404).
 */
export function routeHttpRequest(
  url: string
): "bridge" | "socket.io" | "not-found" {
  const path = url.split("?")[0];
  if (
    path.startsWith("/bridge/") ||
    path.startsWith("/yjs/") ||
    path === "/health" ||
    path === "/health/yjs"
  ) {
    return "bridge";
  }
  if (path.startsWith(SOCKET_IO_PATH)) return "socket.io";
  return "not-found";
}

/**
 * Setup Socket.IO bridge HTTP endpoint
 */
export function setupBridge(
  io: SocketIOServer,
  httpServer: any,
  yjsServerGetter?: YjsServerAccessor
) {
  if (yjsServerGetter) {
    getYjsServer = yjsServerGetter;
  }

  console.log("[Bridge] Setting up HTTP endpoint...");

  // Intercept HTTP requests for bridge endpoints
  const originalListeners = httpServer.listeners("request").slice();
  httpServer.removeAllListeners("request");

  httpServer.on(
    "request",
    async (req: IncomingMessage, res: ServerResponse) => {
      const route = routeHttpRequest(req.url || "");

      if (route === "bridge") {
        await handleBridgeRequest(io, req, res);
        return;
      }

      if (route === "socket.io") {
        // Pass through to original handlers (Socket.IO)
        for (const listener of originalListeners) {
          listener(req, res);
        }
        return;
      }

      // Anything else used to be handed to Socket.IO, which ignores paths
      // outside its own and never answered: the request hung until the client
      // gave up (Caddy's /realtime/* route did exactly that).
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  );

  console.log("[Bridge] ✅ HTTP endpoint ready at /bridge/emit");
}

/**
 * Handle bridge HTTP requests
 */
async function handleBridgeRequest(
  io: SocketIOServer,
  req: IncomingMessage,
  res: ServerResponse
) {
  const url = req.url || "";

  // Health check endpoint (for debugging connectivity)
  if ((url === "/bridge/health" || url === "/health") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
    return;
  }

  // Yjs health endpoint — reports active rooms and last persistence
  if (url === "/health/yjs" && req.method === "GET") {
    const yjsServer = getYjsServer();
    const activeRooms = yjsServer?.documents.size ?? 0;
    const uptimeSeconds = Math.floor(
      (Date.now() - serverStartAt.getTime()) / 1000
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: lastPersistFailureAt ? "degraded" : "ok",
        activeRooms,
        lastPersistAt: lastPersistAt?.toISOString() ?? null,
        lastPersistFailureAt: lastPersistFailureAt?.toISOString() ?? null,
        persistFailureCount,
        uptimeSeconds,
      })
    );
    return;
  }

  // Emit endpoint
  if (url === "/bridge/emit" && req.method === "POST") {
    await handleEmit(io, req, res);
    return;
  }

  // Yjs state endpoint
  if (
    url.startsWith("/yjs/") &&
    url.includes("/state") &&
    req.method === "GET"
  ) {
    await handleYjsGetState(req, res);
    return;
  }

  // Yjs apply endpoint (the whiteboard place door's write)
  if (/^\/yjs\/[^/]+\/apply$/.test(url) && req.method === "POST") {
    await handleYjsApply(req, res);
    return;
  }

  // Yjs restore endpoint
  if (
    url.startsWith("/yjs/") &&
    url.includes("/restore") &&
    req.method === "POST"
  ) {
    await handleYjsRestore(req, res);
    return;
  }

  // Not found
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

/**
 * Validate the bridge secret.
 *
 * Returns true when the request may proceed. On failure it writes the response
 * and returns false — the caller must return immediately.
 *
 * In PRODUCTION an empty `BRIDGE_SECRET` fails CLOSED: every request gets a
 * 503 and the realtime log says why, once. `/bridge/emit` pushes events to
 * any room, `/yjs/:roomId/state` reads any board and `/yjs/:roomId/restore`
 * overwrites any board, so "no secret" must never mean "no auth" on a pod
 * (anything on the compose network could call them). The installer generates
 * the secret; backend, workers and realtime share it.
 *
 * Outside production an unset secret still passes, so a local dev stack with
 * no `.env` keeps working.
 */
let warnedMissingBridgeSecret = false;
function warnBridgeSecretMissingOnce(): void {
  if (warnedMissingBridgeSecret) return;
  warnedMissingBridgeSecret = true;
  console.error(
    "[Bridge] BRIDGE_SECRET is not set in production — refusing /bridge/emit " +
      "and /yjs/:roomId/{state,restore} (503). Set BRIDGE_SECRET in .env (one " +
      "value shared by backend, workers and realtime) and restart."
  );
}

export function bridgeSecretOk(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const bridgeSecret = process.env.BRIDGE_SECRET;
  if (!bridgeSecret) {
    if (process.env.NODE_ENV !== "production") return true;
    warnBridgeSecretMissingOnce();
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bridge secret not configured" }));
    return false;
  }

  const provided = req.headers["x-bridge-secret"];
  if (typeof provided !== "string" || !safeTokenEqual(provided, bridgeSecret)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

/**
 * Handle event emission
 */
async function handleEmit(
  io: SocketIOServer,
  req: IncomingMessage,
  res: ServerResponse
) {
  try {
    if (!bridgeSecretOk(req, res)) return;

    // Parse request body
    const body = await parseBody(req);
    const { event, workspaceId, viewId, userId, channelId, data } =
      body as BridgeEmitRequest;

    // Validate required fields
    if (!event) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required field: event" }));
      return;
    }

    if (!workspaceId && !viewId && !userId && !channelId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "Must provide at least one of: workspaceId, viewId, userId, channelId",
        })
      );
      return;
    }

    // Validate payload against the registered schema (if any). Legacy events
    // without a schema fall through unchanged — backwards-compat is mandatory.
    const validation = validateEmitPayload(event, data);
    if (!validation.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid event payload",
          event,
          issues: validation.issues,
        })
      );
      return;
    }

    // Get presence namespace
    const presenceNamespace = io.of("/presence");

    // Emit to appropriate room(s)
    let emitCount = 0;

    if (channelId) {
      // Channel-scoped: only clients who joined this specific channel room receive the event.
      // This reduces unnecessary traffic for high-frequency stream chunks.
      presenceNamespace.to(`channel:${channelId}`).emit(event, data);
      emitCount++;
    }

    if (workspaceId) {
      presenceNamespace.to(`workspace:${workspaceId}`).emit(event, data);
      emitCount++;
    }

    if (viewId) {
      presenceNamespace.to(`view:${viewId}`).emit(event, data);
      emitCount++;
    }

    if (userId) {
      presenceNamespace.to(`user:${userId}`).emit(event, data);
      emitCount++;
    }

    console.log(`[Bridge] Emitted '${event}' to ${emitCount} room(s)`, {
      workspaceId,
      viewId,
      userId,
      channelId,
    });

    // Success response
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        emitCount,
        event,
      })
    );
  } catch (error) {
    console.error("[Bridge] Error handling emit:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Internal server error",
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

/**
 * Parse request body
 */
/** The largest body the apply route reads (bytes): bigger is refused. */
export const BRIDGE_MAX_BODY_BYTES = 10 * 1024 * 1024;

function parseBody(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (maxBytes !== undefined && size > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

/**
 * Handle Yjs state fetch
 * GET /yjs/:roomId/state
 *
 * Returns the current Yjs document state as base64-encoded binary.
 * Only works for rooms that are currently active (have connected clients).
 */
async function handleYjsGetState(req: IncomingMessage, res: ServerResponse) {
  try {
    // Same gate as /bridge/emit — this listener binds 0.0.0.0:4001.
    if (!bridgeSecretOk(req, res)) return;

    const match = req.url?.match(/\/yjs\/([^/]+)\/state/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid URL" }));
      return;
    }

    const roomId = decodeURIComponent(match[1]);
    const yjsServer = getYjsServer();

    if (!yjsServer) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Yjs server not yet initialized" }));
      return;
    }

    const doc = yjsServer.documents.get(roomId);
    if (!doc) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Room not active — load from database instead",
          roomId,
        })
      );
      return;
    }

    const state = Y.encodeStateAsUpdate(doc);
    const base64State = Buffer.from(state).toString("base64");
    // The server's own flag (never a Y.Doc key): this room failed to load the
    // board's saved content, so its state is not the board.
    const failure = whiteboardLoadFailure(doc);
    const reply: YjsRoomStateReply = {
      roomId,
      state: base64State,
      encoding: "base64",
      byteLength: state.byteLength,
      ...(failure ? { loadFailed: true, loadError: failure.message } : {}),
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  } catch (error) {
    console.error("[Bridge] Error getting Yjs state:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to encode state" }));
  }
}

/**
 * Handle Yjs state restore
 * POST /yjs/:roomId/restore
 *
 * Applies a Yjs state update to an active room. If the room is not active,
 * returns success — the state will be applied via database on next room open.
 */
async function handleYjsRestore(req: IncomingMessage, res: ServerResponse) {
  try {
    // Same gate as /bridge/emit — this is a data-destruction door on 0.0.0.0:4001.
    if (!bridgeSecretOk(req, res)) return;

    const match = req.url?.match(/\/yjs\/([^/]+)\/restore/);
    if (!match) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid URL" }));
      return;
    }

    const roomId = decodeURIComponent(match[1]);
    const body = await parseBody(req);
    const { state } = body as { state: string };

    if (!state) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing state in request body" }));
      return;
    }

    const yjsServer = getYjsServer();
    if (!yjsServer) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Yjs server not yet initialized" }));
      return;
    }

    const doc = yjsServer.documents.get(roomId);
    if (!doc) {
      // Room not active — state will be applied from DB on next open
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          roomId,
          applied: false,
          message: "Room not active — state will apply on next open via DB",
        })
      );
      return;
    }

    // A room that failed to load the board takes no restore: it would be
    // dropped at close (the room is never saved) while the caller announced
    // "restored". Refuse it, saying why.
    const failure = whiteboardLoadFailure(doc);
    if (failure) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: failure.message,
          reason: "load-failed",
          roomId,
          applied: false,
        })
      );
      return;
    }

    const stateBuffer = Buffer.from(state, "base64");
    Y.applyUpdate(doc, new Uint8Array(stateBuffer));
    console.log(`[Bridge] Restored Yjs state for room: ${roomId}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, roomId, applied: true }));
  } catch (error) {
    console.error("[Bridge] Error restoring Yjs state:", error);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to apply state update" }));
  }
}

/** The record kinds the place door writes (tldraw typeName → id prefix). */
const APPLY_RECORD_PREFIX: Record<string, string> = {
  shape: "shape:",
  page: "page:",
  binding: "binding:",
};
/** At most this many records per apply (a 50-slide deck is ~100). */
export const YJS_APPLY_MAX_RECORDS = 1000;
/** Largest serialized record in `put` (chars). */
export const YJS_APPLY_MAX_RECORD_CHARS = 200_000;

/**
 * Read an apply body, or say what is wrong with it. Only whiteboard rooms,
 * the room of the named document, tldraw shape/page/binding records whose id
 * matches their typeName; patches name shapes; removals name shapes.
 */
export function parseYjsApplyRequest(
  roomId: string,
  body: unknown
): { ok: true; request: YjsRoomApplyRequest } | { ok: false; error: string } {
  const room = /^whiteboard-([0-9a-f-]{36})$/i.exec(roomId);
  if (!room)
    return { ok: false, error: "Only a whiteboard room takes records." };
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { ok: false, error: "The body must be an object." };
  const b = body as Record<string, unknown>;
  if (b.documentId !== room[1])
    return { ok: false, error: "documentId does not name this room's board." };
  if (typeof b.origin !== "string" || !b.origin || b.origin.length > 200)
    return { ok: false, error: "origin is required (who writes)." };
  const put = b.put ?? [];
  const patch = b.patch ?? [];
  const remove = b.remove ?? [];
  if (!Array.isArray(put) || !Array.isArray(patch) || !Array.isArray(remove))
    return { ok: false, error: "put, patch and remove must be arrays." };
  const total = put.length + patch.length + remove.length;
  if (total === 0) return { ok: false, error: "Nothing to apply." };
  if (total > YJS_APPLY_MAX_RECORDS)
    return {
      ok: false,
      error: `At most ${YJS_APPLY_MAX_RECORDS} records per apply.`,
    };
  for (const record of put) {
    const r = record as Record<string, unknown> | null;
    const prefix =
      r && typeof r === "object" && typeof r.typeName === "string"
        ? APPLY_RECORD_PREFIX[r.typeName]
        : undefined;
    if (!prefix || typeof r?.id !== "string" || !r.id.startsWith(prefix)) {
      return {
        ok: false,
        error:
          "Every record in put is a tldraw shape, page or binding whose id matches its typeName.",
      };
    }
    if (JSON.stringify(r).length > YJS_APPLY_MAX_RECORD_CHARS) {
      return {
        ok: false,
        error: `A record in put is larger than ${YJS_APPLY_MAX_RECORD_CHARS} characters.`,
      };
    }
  }
  for (const u of patch) {
    const p = u as Record<string, unknown> | null;
    if (
      !p ||
      typeof p !== "object" ||
      typeof p.shapeId !== "string" ||
      !p.shapeId.startsWith("shape:")
    ) {
      return { ok: false, error: "Every patch names a shape (shapeId)." };
    }
  }
  for (const id of remove) {
    if (typeof id !== "string" || !id.startsWith("shape:")) {
      return { ok: false, error: "Every id in remove is a shape id." };
    }
  }
  return {
    ok: true,
    request: {
      documentId: room[1],
      origin: b.origin,
      ...(put.length > 0 ? { put: put as YjsRoomApplyRequest["put"] } : {}),
      ...(patch.length > 0
        ? { patch: patch as YjsRoomApplyRequest["patch"] }
        : {}),
      ...(remove.length > 0 ? { remove: remove as string[] } : {}),
    },
  };
}

function applyError(
  res: ServerResponse,
  reason: YjsApplyFailure,
  error: string,
  roomId?: string
) {
  const body: YjsRoomApplyError = {
    error,
    reason,
    ...(roomId ? { roomId } : {}),
  };
  res.writeHead(YJS_APPLY_FAILURES[reason], {
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(body));
}

/**
 * Handle a whiteboard write
 * POST /yjs/:roomId/apply
 *
 * The place door's ONE write (`YjsRoomApplyRequest`): records into the open
 * room or the stored file, under the room's lock (`applyWhiteboardRecords`,
 * yjs-server.ts). A refusal is an error with a `reason`, never a success
 * that wrote nothing (unlike `/restore`, which answers 200 for a closed room).
 */
async function handleYjsApply(req: IncomingMessage, res: ServerResponse) {
  // Same gate as /bridge/emit: this writes any board.
  if (!bridgeSecretOk(req, res)) return;
  const match = req.url?.match(/^\/yjs\/([^/]+)\/apply$/);
  const roomId = match ? decodeURIComponent(match[1]) : "";
  let body: unknown;
  try {
    body = await parseBody(req, BRIDGE_MAX_BODY_BYTES);
  } catch (err) {
    applyError(
      res,
      "bad_request",
      err instanceof Error && err.message === "Body too large"
        ? "The body is too large."
        : "Invalid JSON",
      roomId
    );
    return;
  }
  const parsed = parseYjsApplyRequest(roomId, body);
  if (!parsed.ok) {
    applyError(res, "bad_request", parsed.error, roomId);
    return;
  }
  const yjsServer = getYjsServer();
  if (!yjsServer?.applyWhiteboardRecords) {
    applyError(res, "unavailable", "Yjs server not yet initialized", roomId);
    return;
  }
  try {
    const reply = await yjsServer.applyWhiteboardRecords(
      roomId,
      parsed.request
    );
    console.log(
      `[Bridge] Applied ${reply.put} created, ${reply.patched} patched, ${reply.removed} removed in ${roomId} (${reply.target})`
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  } catch (error) {
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason in YJS_APPLY_FAILURES) {
      applyError(
        res,
        reason as YjsApplyFailure,
        error instanceof Error ? error.message : String(error),
        roomId
      );
      return;
    }
    console.error("[Bridge] Error applying whiteboard records:", error);
    applyError(
      res,
      "save_failed",
      "The records could not be applied. Retry: the same records replace themselves.",
      roomId
    );
  }
}
