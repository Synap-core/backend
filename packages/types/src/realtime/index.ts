/**
 * Real-Time Collaboration Types
 *
 * Types for real-time presence and collaboration features.
 * Re-exports Yjs types from yjs package for single source of truth.
 */

// Re-export Yjs types (single source of truth)
export type {
  Doc as YDoc,
  Map as YMap,
  Array as YArray,
  Text as YText,
} from "yjs";

/**
 * User presence in a view
 */
export interface UserPresence {
  userId: string;
  userName: string;
  viewId: string;
  viewType: string;
  color: string;
  cursor?: {
    x: number;
    y: number;
  };
  isTyping?: boolean;
  lastSeen: Date;
}

/**
 * Presence status
 */
export type PresenceStatus = "active" | "idle" | "offline";

/**
 * Collaboration event
 */
export interface CollaborationEvent {
  type: string;
  viewId: string;
  userId: string;
  data: unknown;
  timestamp: Date;
}

/**
 * Presence initialization data
 */
export interface PresenceInit {
  users: UserPresence[];
  yourColor: string;
}

/**
 * Cursor update event
 */
export interface CursorUpdate {
  userId: string;
  x: number;
  y: number;
  viewId: string;
}

/**
 * User joined event (emitted when user joins a workspace/document)
 */
export interface UserJoinedEvent {
  userId: string;
  userName: string;
  workspaceId: string;
  documentId?: string;
  color?: string;
  timestamp: number;
}

/**
 * User left event (emitted when user leaves a workspace/document)
 */
export interface UserLeftEvent {
  userId: string;
  workspaceId: string;
  documentId?: string;
  timestamp: number;
}
