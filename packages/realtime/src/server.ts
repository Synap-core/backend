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
import { setupYjsServer, type YjsServerInstance } from "./yjs-server.js";
import { setupBridge } from "./bridge.js";
import { validateRealtimeApiKey } from "./api-key-auth.js";
import { getKratosSessionByToken } from "@synap/auth";
import { db, and, eq } from "@synap/database";
import { workspaceMembers, channels, views } from "@synap/database/schema";

/** Is `userId` a member of `workspaceId`? */
async function isWorkspaceMember(
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const m = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
  });
  return !!m;
}

/**
 * Authorize a USER principal joining a realtime room. Rooms are
 * `<prefix>:<id>` — the dynamic `join-room` path must check membership/ownership
 * per prefix, NOT trust the caller (otherwise any socket reads any channel's
 * stream by id). Service-account observers (realtime:observe) bypass this.
 */
async function canUserJoinRoom(
  roomId: string,
  userId: string
): Promise<boolean> {
  const idx = roomId.indexOf(":");
  if (idx <= 0) return false;
  const prefix = roomId.slice(0, idx);
  const id = roomId.slice(idx + 1);
  if (!id) return false;
  switch (prefix) {
    case "user":
      return id === userId;
    case "workspace":
      return isWorkspaceMember(id, userId);
    case "channel": {
      const ch = await db.query.channels.findFirst({
        where: eq(channels.id, id),
        columns: { userId: true, workspaceId: true },
      });
      if (!ch) return false;
      if (ch.userId === userId) return true;
      return ch.workspaceId ? isWorkspaceMember(ch.workspaceId, userId) : false;
    }
    case "view": {
      const v = await db.query.views.findFirst({
        where: eq(views.id, id),
        columns: { userId: true, workspaceId: true },
      });
      if (!v) return false;
      if (v.userId === userId) return true;
      return v.workspaceId ? isWorkspaceMember(v.workspaceId, userId) : false;
    }
    default:
      return false; // unknown prefix → deny
  }
}

const PORT = parseInt(process.env.REALTIME_PORT || "4001", 10);
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

/**
 * First-party origin policy — mirrors apps/api/src/cors-origin.ts. This is a
 * separate process/package so the small check is duplicated by design.
 * The Socket.IO handshake is cookie-authed, so reflecting every origin is a
 * CSWSH surface; derive from SYNAP_BASE_DOMAIN + the explicit allowlist instead.
 */
function isAllowedRealtimeOrigin(origin?: string): boolean {
  if (!origin || origin === "null") return true; // native/same-origin or Electron (opaque origin) — CORS does not apply
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false; // malformed origin
  }
  const host = u.hostname.toLowerCase();
  const base = process.env.SYNAP_BASE_DOMAIN?.trim()
    .replace(/^\.+/, "")
    .toLowerCase();
  // Derived subdomain trust requires https + the default port (dev allows http) —
  // matches apps/api/src/cors-origin.ts.
  const schemeOk =
    u.protocol === "https:" || process.env.NODE_ENV !== "production";
  if (
    base &&
    schemeOk &&
    u.port === "" &&
    (host === base || host.endsWith(`.${base}`))
  ) {
    return true;
  }
  // Explicit allowlist. FRONTEND_URL is included only when actually set — never
  // its localhost default — so production can't silently trust localhost.
  const explicit = [
    ...(process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()),
    process.env.PUBLIC_URL ?? "",
    ...(process.env.FRONTEND_URL ? [FRONTEND_URL] : []),
  ].filter(Boolean);
  return explicit.some((o) => {
    try {
      return new URL(o).origin === u.origin;
    } catch {
      return false;
    }
  });
}

// Create HTTP server
const httpServer = createServer();

// Create Socket.IO server
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: (origin, cb) => cb(null, isAllowedRealtimeOrigin(origin)),
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
// Use lazy getter because yjsServer is created after bridge setup
let yjsServerRef: YjsServerInstance | null = null;
setupBridge(io, httpServer, () => yjsServerRef);

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
yjsServerRef = yjsServer; // Make available to bridge for /yjs/state and /yjs/restore endpoints

/**
 * Generic Presence WebSocket Handler (/presence namespace)
 *
 * Auth contract (Phase 3A):
 *   • `userId` (existing path) — human or agent user. The handshake also
 *     supplies `viewId` or `workspaceId` for room membership. Unchanged.
 *   • `apiKey` (new path)      — a service-account API key with the
 *     `realtime:observe` scope. The key is bcrypt-validated against
 *     `api_keys` and the resolved row's `userId` is used as the socket's
 *     principal. The key holder may join any `workspace:${id}` room — see
 *     §"Room authorization" below for the rationale.
 *
 * Both paths converge on the same downstream behavior (room joins, presence
 * tracking). The only observable difference is the principal type, exposed
 * to the rest of the server via `socket.data.principal`.
 *
 * Room authorization (Phase 3A):
 *   A service account with `realtime:observe` may join any `workspace:${id}`
 *   room. This is intentional — the v1 consumer (Eve dashboard) runs locally
 *   on the operator's own pod and observes the operator's own data. Per-
 *   workspace ACLs are deferred to Phase 4+ when third-party realtime
 *   observers become a concern. See `eve-os-vision.mdx` §9 / §10.
 */
presenceNamespace.use(async (socket, next) => {
  // Extract auth from handshake — exactly one of (userId, apiKey) must be present.
  const auth = socket.handshake.auth as Record<string, unknown>;
  const apiKey = typeof auth.apiKey === "string" ? auth.apiKey : null;
  const userId = typeof auth.userId === "string" ? auth.userId : null;
  const token = typeof auth.token === "string" ? auth.token : null;
  const workspaceId =
    typeof auth.workspaceId === "string" ? auth.workspaceId : null;

  if (apiKey) {
    const validated = await validateRealtimeApiKey(apiKey);
    if (!validated) {
      console.error(
        "[Presence] API-key handshake rejected (invalid / expired / wrong scope)"
      );
      return next(new Error("Realtime auth: invalid api key"));
    }
    socket.data.principal = {
      kind: "service",
      userId: validated.userId,
      apiKeyId: validated.apiKeyId,
      keyName: validated.keyName,
      scopes: validated.scopes,
    };
    return next();
  }

  if (userId) {
    if (!token) {
      console.error("[Presence] Missing session token for user handshake");
      return next(new Error("Realtime auth: missing session token"));
    }

    let session: Awaited<ReturnType<typeof getKratosSessionByToken>> | null;
    try {
      session = await getKratosSessionByToken(token);
    } catch {
      return next(new Error("Realtime auth: session validation unavailable"));
    }

    const resolvedUserId =
      typeof session?.identity?.id === "string" ? session.identity.id : null;
    if (!resolvedUserId || session?.active === false) {
      console.error("[Presence] Invalid or inactive user session");
      return next(new Error("Realtime auth: invalid session"));
    }

    if (resolvedUserId !== userId) {
      console.error("[Presence] Handshake userId does not match session");
      return next(new Error("Realtime auth: user mismatch"));
    }

    if (workspaceId) {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, resolvedUserId)
        ),
      });
      if (!membership) {
        console.error("[Presence] User is not a member of requested workspace");
        return next(new Error("Realtime auth: workspace access denied"));
      }
    }

    socket.data.principal = { kind: "user", userId: resolvedUserId };
    return next();
  }

  console.error(
    "[Presence] Missing userId or apiKey in handshake, disconnecting"
  );
  return next(new Error("Realtime auth: missing userId or apiKey"));
});

presenceNamespace.on("connection", (socket) => {
  console.log(`[Presence] Client connected: ${socket.id}`);

  // The middleware above guarantees one of these two principal shapes.
  const principal = socket.data.principal as
    | { kind: "user"; userId: string }
    | {
        kind: "service";
        userId: string;
        apiKeyId: string;
        keyName: string;
        scopes: string[];
      }
    | undefined;

  if (!principal) {
    // Defense in depth — should never happen given the middleware.
    console.error("[Presence] No principal on socket, disconnecting");
    socket.disconnect();
    return;
  }

  const { userId } = principal;
  const isServiceAccount = principal.kind === "service";

  // Service-account observers connect at the workspace (or pod) level; they
  // skip user-level handshake fields entirely.
  const userName = isServiceAccount
    ? (principal as { kind: "service"; keyName: string }).keyName
    : typeof socket.handshake.auth.userName === "string"
      ? socket.handshake.auth.userName
      : null;
  const viewId =
    typeof socket.handshake.auth.viewId === "string"
      ? socket.handshake.auth.viewId
      : null;
  const viewType =
    typeof socket.handshake.auth.viewType === "string"
      ? socket.handshake.auth.viewType
      : null;
  const workspaceId =
    typeof socket.handshake.auth.workspaceId === "string"
      ? socket.handshake.auth.workspaceId
      : null;

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
  // Join user-specific room so bridge emissions to user:${userId} reach this client.
  // Service accounts get their own user room too — keeps direct-to-key
  // emits possible in the future without a special-case branch.
  socket.join(`user:${userId}`);

  // Register user in collaboration manager. Service-account sessions are
  // tracked too, so presence indicators in the dashboard reflect "Eve is
  // watching." (UX layer can choose to hide them if undesirable.)
  // NOTE: the `as` cast preserves pre-existing behavior — the runtime has
  // always allowed `"workspace"` as a viewType for workspace-level sockets,
  // but the literal isn't in the type union in presence-manager.ts. Fixing
  // that union is out of scope for this Phase 3A change.
  const session = collaborationManager.userJoined({
    viewId: effectiveViewId,
    viewType: (viewType || (workspaceId ? "workspace" : "document")) as
      | "whiteboard"
      | "document"
      | "timeline"
      | "kanban"
      | "ai-chat",
    userId,
    userName: userName || (isServiceAccount ? "Service" : "Anonymous"),
    socketId: socket.id,
  });

  console.log(
    `[Presence] ${isServiceAccount ? "Service" : "User"} ${userName || userId} (${userId}) joined ${effectiveViewId}`
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
  socket.on(
    "typing",
    (payload: boolean | { isTyping?: boolean; documentId?: string }) => {
      const isTyping =
        typeof payload === "boolean" ? payload : payload?.isTyping === true;
      const documentId =
        typeof payload === "object" && typeof payload?.documentId === "string"
          ? payload.documentId
          : undefined;
      collaborationManager.setTyping({
        socketId: socket.id,
        viewId: effectiveViewId,
        isTyping,
        documentId,
      });
    }
  );

  // Event: Heartbeat (keep session alive). Accept both the legacy fire-and-
  // forget event and the client heartbeat that expects an explicit pong.
  socket.on("heartbeat", () => {
    collaborationManager.heartbeat(socket.id);
  });
  socket.on("ping_heartbeat", () => {
    collaborationManager.heartbeat(socket.id);
    socket.emit("pong_heartbeat");
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

  // Event: Dynamic room join/leave (so clients can subscribe to extra rooms after connection)
  socket.on("join-room", async (roomId: string) => {
    if (typeof roomId !== "string" || roomId.length === 0) return;
    // Service-account observers (realtime:observe) keep their documented broad
    // allowance; user principals must be authorized for the room — otherwise
    // any socket could join channel:<id>/workspace:<id> and read its stream.
    if (isServiceAccount || (await canUserJoinRoom(roomId, userId))) {
      socket.join(roomId);
    } else {
      console.error(`[Presence] join-room denied: ${userId} → ${roomId}`);
    }
  });
  socket.on("leave-room", (roomId: string) => {
    if (typeof roomId === "string") {
      socket.leave(roomId);
    }
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
process.on("SIGTERM", async () => {
  console.log("[Shutdown] Flushing Yjs pending saves...");
  if (yjsServerRef?.flushAll) {
    await yjsServerRef.flushAll();
  }
  console.log("[Shutdown] Closing WebSocket server...");
  httpServer.close(() => {
    console.log("[Shutdown] Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", async () => {
  console.log("[Shutdown] Flushing Yjs pending saves (SIGINT)...");
  if (yjsServerRef?.flushAll) {
    await yjsServerRef.flushAll();
  }
  process.exit(0);
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
