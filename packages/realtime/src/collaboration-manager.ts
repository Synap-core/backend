/**
 * Collaboration Manager - Orchestrates real-time collaboration
 *
 * Provides high-level API for:
 * - User presence tracking
 * - Cursor broadcasting (for non-Yjs views)
 * - Generic event broadcasting
 * - Typing indicators
 */

import type { Namespace } from "socket.io";
import {
  PresenceManager,
  type UserSession,
  generateUserColor,
} from "./presence-manager.js";

export interface CollaborationEvent {
  type: string;
  viewId: string;
  userId: string;
  data: any;
  timestamp: number;
}

export class CollaborationManager {
  private presenceManager: PresenceManager;

  constructor(private io: Namespace) {
    this.presenceManager = new PresenceManager();

    // Cleanup stale sessions every 10 seconds
    setInterval(() => {
      const removed = this.presenceManager.cleanupStaleSessions();
      removed.forEach((session) => {
        this.broadcastUserLeft(session.viewId, session.userId);
      });
    }, 10000);
  }

  /**
   * User joins a view
   */
  userJoined(params: {
    viewId: string;
    viewType: UserSession["viewType"];
    userId: string;
    userName: string;
    socketId: string;
    metadata?: Record<string, any>;
  }): UserSession {
    const session = this.presenceManager.addUser({
      ...params,
      color: generateUserColor(params.userId),
    });

    // Broadcast to others in the view
    this.io
      .to(`view:${params.viewId}`)
      .except(params.socketId)
      .emit("user:joined", {
        userId: params.userId,
        userName: params.userName,
        color: session.color,
        timestamp: Date.now(),
      });

    return session;
  }

  /**
   * User leaves a view
   */
  userLeft(socketId: string): void {
    const session = this.presenceManager.removeUser(socketId);
    if (session) {
      this.broadcastUserLeft(session.viewId, session.userId);
    }
  }

  /**
   * Get all active users in a view
   */
  getActiveUsers(viewId: string): UserSession[] {
    return this.presenceManager.getUsersInView(viewId);
  }

  /**
   * Get global presence (all users, all views)
   */
  getGlobalPresence(): UserSession[] {
    return this.presenceManager.getAllSessions();
  }

  /**
   * Update cursor position (for non-Yjs views like timelines)
   */
  updateCursor(params: {
    socketId: string;
    viewId: string;
    cursor: { x: number; y: number };
  }): void {
    this.presenceManager.updateCursor(params.socketId, params.cursor);

    const session = this.presenceManager.getSession(params.socketId);
    if (session) {
      // Broadcast to others in view
      this.io
        .to(`view:${params.viewId}`)
        .except(params.socketId)
        .emit("cursor:update", {
          userId: session.userId,
          cursor: params.cursor,
          color: session.color,
          timestamp: Date.now(),
        });
    }
  }

  /**
   * Typing indicator (for documents, AI chats)
   */
  setTyping(params: {
    socketId: string;
    viewId: string;
    isTyping: boolean;
  }): void {
    const session = this.presenceManager.getSession(params.socketId);
    if (session) {
      this.presenceManager.updateMetadata(params.socketId, {
        isTyping: params.isTyping,
      });

      this.io
        .to(`view:${params.viewId}`)
        .except(params.socketId)
        .emit("user:typing", {
          userId: session.userId,
          userName: session.userName,
          isTyping: params.isTyping,
          timestamp: Date.now(),
        });
    }
  }

  /**
   * Broadcast generic collaboration event
   */
  broadcastEvent(event: CollaborationEvent): void {
    this.io.to(`view:${event.viewId}`).emit("collaboration:event", event);
  }

  /**
   * Heartbeat to keep session alive
   */
  heartbeat(socketId: string): void {
    this.presenceManager.heartbeat(socketId);
  }

  /**
   * Private: Broadcast user left event
   */
  private broadcastUserLeft(viewId: string, userId: string): void {
    this.io.to(`view:${viewId}`).emit("user:left", {
      userId,
      timestamp: Date.now(),
    });
  }

  /**
   * Get stats for monitoring
   */
  getStats() {
    return {
      totalSessions: this.presenceManager.getTotalSessionCount(),
      sessionsByView: Array.from(this.presenceManager.getAllSessions()).reduce(
        (acc, session) => {
          acc[session.viewId] = (acc[session.viewId] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    };
  }
}
