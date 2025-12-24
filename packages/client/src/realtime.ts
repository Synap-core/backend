/**
 * Real-Time Client - WebSocket connection management for Synap
 * 
 * Manages two WebSocket namespaces:
 * 1. /presence - Generic real-time presence and collaboration
 * 2. /yjs - Yjs CRDT synchronization
 */

import { io, Socket } from 'socket.io-client';
import * as Y from 'yjs';
import type { UserPresence, PresenceInit, CursorUpdate } from '@synap-core/types/realtime';

export interface RealtimeConfig {
  url: string;
  auth: {
    userId: string;
    userName: string;
  };
}

type EventCallback = (...args: any[]) => void;

/**
 * Real-time collaboration client
 * 
 * Handles presence tracking and Yjs document synchronization.
 * 
 * @example
 * ```typescript
 * const realtime = new RealtimeClient({
 *   url: 'http://localhost:3001',
 *   auth: { userId: 'user-123', userName: 'Alice' }
 * });
 * 
 * // Connect to presence
 * realtime.connectPresence('view-id', 'whiteboard');
 * realtime.on('user-joined', (user) => console.log(user));
 * 
 * // Connect to Yjs
 * const ydoc = realtime.connectYjs('view-id');
 * const ymap = ydoc.getMap('shapes');
 * ```
 */
export class RealtimeClient {
  private presenceSocket: Socket | null = null;
  private yjsSocket: Socket | null = null;
  private listeners = new Map<string, Set<EventCallback>>();
  
  constructor(private config: RealtimeConfig) {}
  
  /**
   * Connect to presence namespace for real-time collaboration
   */
  connectPresence(viewId: string, viewType: string = 'document') {
    if (this.presenceSocket) {
      this.presenceSocket.disconnect();
    }
    
    this.presenceSocket = io(`${this.config.url}/presence`, {
      auth: {
        ...this.config.auth,
        viewId,
        viewType,
      },
    });
    
    // Presence events
    this.presenceSocket.on('presence:init', (data: PresenceInit) => {
      this.emit('presence:init', data);
    });
    
    this.presenceSocket.on('user:joined', (user: UserPresence) => {
      this.emit('user-joined', user);
    });
    
    this.presenceSocket.on('user:left', (data: { userId: string }) => {
      this.emit('user-left', data);
    });
    
    this.presenceSocket.on('cursor:update', (data: CursorUpdate) => {
      this.emit('cursor-update', data);
    });
    
    this.presenceSocket.on('typing', (data: { userId: string; isTyping: boolean }) => {
      this.emit('typing', data);
    });
  }
  
  /**
   * Connect to Yjs namespace for CRDT synchronization
   * 
   * @returns Yjs document that auto-syncs with server
   */
  connectYjs(roomName: string): Y.Doc {
    if (this.yjsSocket) {
      this.yjsSocket.disconnect();
    }
    
    const ydoc = new Y.Doc();
    
    this.yjsSocket = io(`${this.config.url}/yjs`, {
      query: { room: roomName },
    });
    
    // Yjs sync protocol
    this.yjsSocket.on('yjs:sync', (message: number[]) => {
      Y.applyUpdate(ydoc, Uint8Array.from(message));
    });
    
    this.yjsSocket.on('yjs:update', (message: number[]) => {
      Y.applyUpdate(ydoc, Uint8Array.from(message), this.yjsSocket);
    });
    
    // Send local updates to server
    ydoc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== this.yjsSocket) {
        this.yjsSocket?.emit('yjs:update', Array.from(update));
      }
    });
    
    return ydoc;
  }
  
  /**
   * Subscribe to events
   */
  on(event: string, callback: EventCallback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }
  
  /**
   * Unsubscribe from events
   */
  off(event: string, callback: EventCallback) {
    this.listeners.get(event)?.delete(callback);
  }
  
  /**
   * Emit event to all listeners
   */
  private emit(event: string, data: any) {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }
  
  /**
   * Move cursor (presence)
   */
  moveCursor(x: number, y: number) {
    this.presenceSocket?.emit('cursor:move', { x, y });
  }
  
  /**
   * Set typing indicator
   */
  setTyping(isTyping: boolean) {
    this.presenceSocket?.emit('typing', isTyping);
  }
  
  /**
   * Disconnect all connections
   */
  disconnect() {
    this.presenceSocket?.disconnect();
    this.yjsSocket?.disconnect();
    this.presenceSocket = null;
    this.yjsSocket = null;
    this.listeners.clear();
  }
}

/**
 * Create a real-time client instance
 */
export function createRealtimeClient(config: RealtimeConfig): RealtimeClient {
  return new RealtimeClient(config);
}
