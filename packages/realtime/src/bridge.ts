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
type YjsServerAccessor = () => { documents: Map<string, Y.Doc> } | null;
let getYjsServer: YjsServerAccessor = () => null;

/** Track last successful MinIO/DB write for /health/yjs */
let lastPersistAt: Date | null = null;
const serverStartAt = new Date();

export function recordYjsPersist(): void {
  lastPersistAt = new Date();
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
      const url = req.url || "";

      // Handle bridge endpoints
      if (url.startsWith("/bridge/")) {
        await handleBridgeRequest(io, req, res);
        return;
      }

      // Handle Yjs endpoints
      if (url.startsWith("/yjs/")) {
        await handleBridgeRequest(io, req, res);
        return;
      }

      // Handle health check at root
      if (url === "/health" && req.method === "GET") {
        await handleBridgeRequest(io, req, res);
        return;
      }

      // Pass through to original handlers (Socket.IO)
      for (const listener of originalListeners) {
        listener(req, res);
      }
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
        status: "ok",
        activeRooms,
        lastPersistAt: lastPersistAt?.toISOString() ?? null,
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
 * Handle event emission
 */
async function handleEmit(
  io: SocketIOServer,
  req: IncomingMessage,
  res: ServerResponse
) {
  try {
    // Validate bridge secret (if configured)
    const bridgeSecret = process.env.BRIDGE_SECRET;
    if (bridgeSecret) {
      const provided = req.headers["x-bridge-secret"];
      if (provided !== bridgeSecret) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

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
function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
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

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        roomId,
        state: base64State,
        encoding: "base64",
        byteLength: state.byteLength,
      })
    );
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
