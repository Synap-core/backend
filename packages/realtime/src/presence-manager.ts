/**
 * Presence Manager - Track active users across views
 *
 * Generic presence system that works for ALL view types:
 * - Documents (markdown editing)
 * - Whiteboards (Yjs handles canvas, we track who's there)
 * - Timelines, Kanban, etc.
 * - Sidebar (global "who's online where")
 */

export interface UserSession {
  userId: string;
  userName: string;
  viewId: string;
  viewType: "whiteboard" | "document" | "timeline" | "kanban" | "ai-chat";
  socketId: string;
  color: string;
  cursor?: { x: number; y: number }; // For non-Yjs views
  lastSeen: Date;
  metadata?: Record<string, any>; // Custom per view type
}

export interface PresenceUpdate {
  type: "join" | "leave" | "update";
  session: UserSession;
  timestamp: Date;
}

/**
 * Manages user presence across all views
 *
 * Note: For whiteboards/documents, Yjs handles canvas-specific presence.
 * This manager handles:
 * 1. Room-level presence (who's in which view)
 * 2. Cross-view presence (sidebar shows all users)
 * 3. Non-Yjs views (timelines, kanban) presence
 */
export class PresenceManager {
  private sessions = new Map<string, UserSession>();
  private viewToSockets = new Map<string, Set<string>>();

  /**
   * User joins a view
   */
  addUser(session: Omit<UserSession, "lastSeen">): UserSession {
    const fullSession: UserSession = {
      ...session,
      lastSeen: new Date(),
    };

    this.sessions.set(session.socketId, fullSession);

    // Track socket → view mapping
    if (!this.viewToSockets.has(session.viewId)) {
      this.viewToSockets.set(session.viewId, new Set());
    }
    this.viewToSockets.get(session.viewId)!.add(session.socketId);

    return fullSession;
  }

  /**
   * User leaves a view
   */
  removeUser(socketId: string): UserSession | undefined {
    const session = this.sessions.get(socketId);
    if (!session) return undefined;

    this.sessions.delete(socketId);

    // Remove from view mapping
    const viewSockets = this.viewToSockets.get(session.viewId);
    if (viewSockets) {
      viewSockets.delete(socketId);
      if (viewSockets.size === 0) {
        this.viewToSockets.delete(session.viewId);
      }
    }

    return session;
  }

  /**
   * Update user's cursor position (for non-Yjs views)
   */
  updateCursor(socketId: string, cursor: { x: number; y: number }): void {
    const session = this.sessions.get(socketId);
    if (session) {
      session.cursor = cursor;
      session.lastSeen = new Date();
    }
  }

  /**
   * Update user's metadata
   */
  updateMetadata(socketId: string, metadata: Record<string, any>): void {
    const session = this.sessions.get(socketId);
    if (session) {
      session.metadata = { ...session.metadata, ...metadata };
      session.lastSeen = new Date();
    }
  }

  /**
   * Heartbeat to keep session alive
   */
  heartbeat(socketId: string): void {
    const session = this.sessions.get(socketId);
    if (session) {
      session.lastSeen = new Date();
    }
  }

  /**
   * Get all users in a specific view
   */
  getUsersInView(viewId: string): UserSession[] {
    const socketIds = this.viewToSockets.get(viewId);
    if (!socketIds) return [];

    return Array.from(socketIds)
      .map((socketId) => this.sessions.get(socketId))
      .filter((session): session is UserSession => session !== undefined);
  }

  /**
   * Get session by socket ID
   */
  getSession(socketId: string): UserSession | undefined {
    return this.sessions.get(socketId);
  }

  /**
   * Get all active sessions (for global presence)
   */
  getAllSessions(): UserSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get sessions by user ID (user may have multiple tabs open)
   */
  getSessionsByUserId(userId: string): UserSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.userId === userId
    );
  }

  /**
   * Clean up stale sessions (no heartbeat for > 30 seconds)
   */
  cleanupStaleSessions(): UserSession[] {
    const now = new Date();
    const staleThreshold = 30 * 1000; // 30 seconds
    const removedSessions: UserSession[] = [];

    for (const [socketId, session] of this.sessions.entries()) {
      const timeSinceLastSeen = now.getTime() - session.lastSeen.getTime();
      if (timeSinceLastSeen > staleThreshold) {
        const removed = this.removeUser(socketId);
        if (removed) {
          removedSessions.push(removed);
        }
      }
    }

    return removedSessions;
  }

  /**
   * Get count of users in view
   */
  getUserCount(viewId: string): number {
    return this.viewToSockets.get(viewId)?.size || 0;
  }

  /**
   * Get total session count
   */
  getTotalSessionCount(): number {
    return this.sessions.size;
  }
}

/**
 * Generate consistent color for a user
 */
export function generateUserColor(userId: string): string {
  const colors = [
    "#FF6B6B", // Red
    "#4ECDC4", // Teal
    "#45B7D1", // Blue
    "#FFA07A", // Salmon
    "#98D8C8", // Mint
    "#F7DC6F", // Yellow
    "#BB8FCE", // Purple
    "#85C1E2", // Sky Blue
    "#F8B88B", // Peach
    "#A8E6CF", // Light Green
  ];

  // Simple hash function
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }

  const index = Math.abs(hash) % colors.length;
  return colors[index];
}
