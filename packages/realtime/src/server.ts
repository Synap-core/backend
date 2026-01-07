/**
 * WebSocket Server Setup for Real-Time Collaboration
 * 
 * This is a standalone Node.js/Bun server that handles:
 * - Phase 4: Generic presence (documents, timelines, sidebar)
 * - Phase 5: Yjs sync (whiteboards + documents)
 * 
 * Can run independently or alongside the main API server
 */

import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import { CollaborationManager } from './collaboration-manager.js';
import { setupYjsServer } from './yjs-server.js';
import { setupBridge } from './bridge.js';

const PORT = process.env.REALTIME_PORT || 4001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Create HTTP server
const httpServer = createServer();

// Create Socket.IO server
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: FRONTEND_URL,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// ============================================================================
// PHASE 3: Setup HTTP Bridge for Inngest Workers
// ============================================================================
// Allows workers to emit real-time events to connected clients via HTTP POST
// Also handles Yjs state management endpoints
setupBridge(io, httpServer);

// Namespace for generic presence/collaboration
const presenceNamespace = io.of('/presence');
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
presenceNamespace.on('connection', (socket) => {
  console.log(`[Presence] Client connected: ${socket.id}`);
  
  // Extract auth from handshake
  const { userId, userName, viewId, viewType } = socket.handshake.auth;
  
  if (!userId || !viewId) {
    console.error('[Presence] Missing auth params, disconnecting');
    socket.disconnect();
    return;
  }
  
  // Join room for this view
  socket.join(`view:${viewId}`);
  
  // Register user in collaboration manager
  const session = collaborationManager.userJoined({
    viewId,
    viewType: viewType || 'document',
    userId,
    userName: userName || 'Anonymous',
    socketId: socket.id,
  });
  
  console.log(`[Presence] User ${userName} (${userId}) joined view ${viewId}`);
  
  // Send current active users to the new joiner
  const activeUsers = collaborationManager.getActiveUsers(viewId);
  socket.emit('presence:init', {
    users: activeUsers,
    yourColor: session.color,
  });
  
  // Event: Cursor movement (for non-Yjs views)
  socket.on('cursor:move', (cursor: { x: number; y: number }) => {
    collaborationManager.updateCursor({
      socketId: socket.id,
      viewId,
      cursor,
    });
  });
  
  // Event: Typing indicator
  socket.on('typing', (isTyping: boolean) => {
    collaborationManager.setTyping({
      socketId: socket.id,
      viewId,
      isTyping,
    });
  });
  
  // Event: Heartbeat (keep session alive)
  socket.on('heartbeat', () => {
    collaborationManager.heartbeat(socket.id);
  });
  
  // Event: Custom collaboration event
  socket.on('collaboration:event', (event: any) => {
    collaborationManager.broadcastEvent({
      type: event.type,
      viewId,
      userId,
      data: event.data,
      timestamp: Date.now(),
    });
  });
  
  // Event: Request presence update
  socket.on('presence:request', () => {
    const activeUsers = collaborationManager.getActiveUsers(viewId);
    socket.emit('presence:update', activeUsers);
  });
  
  // Event: Disconnect
  socket.on('disconnect', () => {
    console.log(`[Presence] Client disconnected: ${socket.id}`);
    collaborationManager.userLeft(socket.id);
  });
});

/**
 * Monitoring
 */
presenceNamespace.adapter.on('create-room', (room: string) => {
  console.log(`[Room] Created: ${room}`);
});

presenceNamespace.adapter.on('delete-room', (room: string) => {
  console.log(`[Room] Deleted: ${room}`);
});

/**
 * Start server
 */
httpServer.listen(PORT, () => {
  console.log(`✅ Real-time WebSocket server running on http://localhost:${PORT}`);
  console.log(`   - Generic presence (/presence): ✅`);
  console.log(`   - Yjs CRDT sync (/yjs): ✅`);
  console.log(`   - Cursor tracking: ✅`);
  console.log(`   - Typing indicators: ✅`);
  console.log(`   - HTTP Bridge (/bridge/emit): ✅`);
});

/**
 * Graceful shutdown
 */
process.on('SIGTERM', () => {
  console.log('[Shutdown] Closing WebSocket server...');
  httpServer.close(() => {
    console.log('[Shutdown] Server closed');
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

