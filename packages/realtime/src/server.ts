/**
 * WebSocket Server Setup for Real-Time Collaboration
 *
 * This is a standalone Node.js/Bun server that handles:
 * - Phase 4: Generic presence (documents, timelines, sidebar)
 * - Phase 5: Yjs sync (whiteboards + documents)
 *
 * Can run independently or alongside the main API server
 */

import { Server as SocketIOServer } from "socket.io";
import { createServer } from "http";
import { CollaborationManager } from "./collaboration-manager.js";
import { setupYjsServer } from "./yjs-server.js";
import { setupBridge } from "./bridge.js";

const PORT = parseInt(process.env.REALTIME_PORT || "4001", 10);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
// CORS origin - allow frontend URL or use wildcard for same-domain setups (Caddy reverse proxy)
const CORS_ORIGIN = process.env.CORS_ORIGIN || FRONTEND_URL;

// Create HTTP server
const httpServer = createServer();

// Create Socket.IO server
const io = new SocketIOServer(httpServer, {
  cors: {
    // Allow all origins when behind reverse proxy (Caddy handles auth)
    // In production, Caddy is the security boundary
    origin: true, // Always allow all origins (Caddy is security boundary)
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"], // Include OPTIONS for preflight
  },
  transports: ["websocket", "polling"],
  // Allow Socket.IO to work behind reverse proxy (Caddy)
  allowEIO3: true,
  // Path for Socket.IO (must match Caddy route)
  path: "/socket.io/",
  // Connection state recovery (helps with reconnections)
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
});

// ============================================================================
// PHASE 3: Setup HTTP Bridge for Inngest Workers
// ============================================================================
// Allows workers to emit real-time events to connected clients via HTTP POST
// Also handles Yjs state management endpoints
setupBridge(io, httpServer);

// Log all connection attempts (for debugging WebSocket routing)
io.engine.on("connection_error", (err) => {
  console.error("[Socket.IO] Connection error:", err.req?.headers, err.message);
});

io.engine.on("initial_headers", (headers, req) => {
  console.log("[Socket.IO] Initial connection attempt:", {
    method: req.method,
    url: req.url,
    origin: req.headers.origin,
    upgrade: req.headers.upgrade,
    connection: req.headers.connection,
  });
});

// Namespace for generic presence/collaboration
const presenceNamespace = io.of("/presence");
const collaborationManager = new CollaborationManager(presenceNamespace);

// Setup Yjs CRDT sync
// NOTE: y-socket.io creates /yjs namespace internally!
// Don't create io.of('/yjs') manually - just pass the full io server
const yjsServer = setupYjsServer({
  io, // Pass full server, y-socket.io creates /yjs namespace
  persistenceInterval: 10000,
});

/**
 * Generic Presence WebSocket Handler (/presence namespace)
 */
presenceNamespace.on("connection", (socket) => {
  console.log(`[Presence] Client connected: ${socket.id}`);

  // Extract auth from handshake
  const { userId, userName, viewId, viewType, workspaceId } =
    socket.handshake.auth;

  // Require userId, and either viewId or workspaceId (for workspace-level connections)
  if (!userId) {
    console.error("[Presence] Missing userId, disconnecting");
    socket.disconnect();
    return;
  }

  // Use viewId if provided, otherwise use workspaceId as fallback for workspace-level presence
  const effectiveViewId =
    viewId || (workspaceId ? `workspace:${workspaceId}` : null);

  if (!effectiveViewId) {
    console.error("[Presence] Missing viewId or workspaceId, disconnecting");
    socket.disconnect();
    return;
  }

  // Join room for this view (or workspace)
  socket.join(`view:${effectiveViewId}`);
  // Also join workspace room so bridge emissions to workspace:${workspaceId} reach this client
  if (workspaceId) {
    socket.join(`workspace:${workspaceId}`);
  }

  // Register user in collaboration manager
  const session = collaborationManager.userJoined({
    viewId: effectiveViewId,
    viewType: viewType || (workspaceId ? "workspace" : "document"),
    userId,
    userName: userName || "Anonymous",
    socketId: socket.id,
  });

  console.log(
    `[Presence] User ${userName || userId} (${userId}) joined ${effectiveViewId}`
  );

  // Send current active users to the new joiner
  const activeUsers = collaborationManager.getActiveUsers(effectiveViewId);
  socket.emit("presence:init", {
    users: activeUsers,
    yourColor: session.color,
  });

  // Event: Cursor movement (for non-Yjs views)
  socket.on("cursor:move", (cursor: { x: number; y: number }) => {
    collaborationManager.updateCursor({
      socketId: socket.id,
      viewId: effectiveViewId,
      cursor,
    });
  });

  // Event: Typing indicator
  socket.on("typing", (isTyping: boolean) => {
    collaborationManager.setTyping({
      socketId: socket.id,
      viewId: effectiveViewId,
      isTyping,
    });
  });

  // Event: Heartbeat (keep session alive)
  socket.on("heartbeat", () => {
    collaborationManager.heartbeat(socket.id);
  });

  // Event: Custom collaboration event
  socket.on("collaboration:event", (event: any) => {
    collaborationManager.broadcastEvent({
      type: event.type,
      viewId: effectiveViewId,
      userId,
      data: event.data,
      timestamp: Date.now(),
    });
  });

  // Event: Request presence update
  socket.on("presence:request", () => {
    const activeUsers = collaborationManager.getActiveUsers(effectiveViewId);
    socket.emit("presence:update", activeUsers);
  });

  // Event: Disconnect
  socket.on("disconnect", () => {
    console.log(`[Presence] Client disconnected: ${socket.id}`);
    collaborationManager.userLeft(socket.id);
  });
});

/**
 * Monitoring
 */
presenceNamespace.adapter.on("create-room", (room: string) => {
  console.log(`[Room] Created: ${room}`);
});

presenceNamespace.adapter.on("delete-room", (room: string) => {
  console.log(`[Room] Deleted: ${room}`);
});

/**
 * Start server
 */
// Listen on 0.0.0.0 to accept connections from other containers (Caddy)
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(
    `✅ Real-time WebSocket server running on http://0.0.0.0:${PORT}`
  );
  console.log(`   - Generic presence (/presence): ✅`);
  console.log(`   - Yjs CRDT sync (/yjs): ✅`);
  console.log(`   - Cursor tracking: ✅`);
  console.log(`   - Typing indicators: ✅`);
  console.log(`   - HTTP Bridge (/bridge/emit): ✅`);
});

/**
 * Graceful shutdown
 */
process.on("SIGTERM", () => {
  console.log("[Shutdown] Closing WebSocket server...");
  httpServer.close(() => {
    console.log("[Shutdown] Server closed");
    process.exit(0);
  });
});

/**
 * Stats endpoint (for monitoring)
 */
setInterval(() => {
  const stats = collaborationManager.getStats();
  if (stats.totalSessions > 0) {
    console.log(`[Stats] Active sessions: ${stats.totalSessions}`);
    console.log(`[Stats] Sessions by view:`, stats.sessionsByView);
  }
}, 60000); // Every minute

export { io, collaborationManager, yjsServer };
