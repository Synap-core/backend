/**
 * Real-Time Package - WebSocket-based real-time collaboration
 * 
 * Provides:
 * - Generic presence tracking (all view types)
 * - Cursor synchronization (non-Yjs views)
 * - Typing indicators
 * - Collaboration events
 * - Yjs CRDT sync (whiteboards + documents)
 * 
 * Note: Whiteboard/document cursors handled by Yjs (Phase 5)
 */

export { PresenceManager, generateUserColor, type UserSession, type PresenceUpdate } from './presence-manager.js';
export { CollaborationManager, type CollaborationEvent } from './collaboration-manager.js';
export { setupYjsServer, type YjsServerConfig } from './yjs-server.js';

// Cloudflare Durable Objects (existing notification system)
export { NotificationRoom } from './notification-room.js';
