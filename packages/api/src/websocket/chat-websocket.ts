/**
 * WebSocket Server for Real-time Chat Updates
 * 
 * Broadcasts events to connected clients:
 * - New messages
 * - Entity creations
 * - Branch creations
 * - Typing indicators
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import type {
  WebSocketEvent,
  MessageReceivedEvent,
  EntityCreatedEvent,
  BranchCreatedEvent,
} from '@synap/types';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  threadId?: string;
  isAlive?: boolean;
}

export class ChatWebSocketServer {
  private wss: WebSocketServer;
  private clients: Map<string, Set<AuthenticatedWebSocket>> = new Map();
  
  constructor(server: any) {
    this.wss = new WebSocketServer({ server });
    
    this.wss.on('connection', this.handleConnection.bind(this));
    
    // Heartbeat to detect dead connections
    this.startHeartbeat();
  }
  
  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: AuthenticatedWebSocket, _req: IncomingMessage) {
    console.log('WebSocket connection established');
    
    ws.isAlive = true;
    
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(ws, message);
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
      }
    });
    
    ws.on('close', () => {
      this.removeClient(ws);
    });
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.removeClient(ws);
    });
  }
  
  /**
   * Handle incoming messages from client
   */
  private handleMessage(ws: AuthenticatedWebSocket, message: any) {
    switch (message.type) {
      case 'auth':
        // Authenticate and register client
        ws.userId = message.userId;
        this.addClient(ws);
        ws.send(JSON.stringify({ type: 'authenticated', userId: message.userId }));
        break;
      
      case 'subscribe':
        // Subscribe to a thread
        ws.threadId = message.threadId;
        ws.send(JSON.stringify({ type: 'subscribed', threadId: message.threadId }));
        break;
      
      case 'typing.start':
        // Broadcast typing indicator
        this.broadcastToThread(message.threadId, {
          type: 'typing.start',
          userId: ws.userId!,
          data: { threadId: message.threadId },
          timestamp: new Date(),
        }, ws.userId);
        break;
      
      case 'typing.stop':
        // Broadcast typing stopped
        this.broadcastToThread(message.threadId, {
          type: 'typing.stop',
          userId: ws.userId!,
          data: { threadId: message.threadId },
          timestamp: new Date(),
        }, ws.userId);
        break;
      
      default:
        console.warn('Unknown WebSocket message type:', message.type);
    }
  }
  
  /**
   * Add client to tracking
   */
  private addClient(ws: AuthenticatedWebSocket) {
    if (!ws.userId) return;
    
    if (!this.clients.has(ws.userId)) {
      this.clients.set(ws.userId, new Set());
    }
    
    this.clients.get(ws.userId)!.add(ws);
  }
  
  /**
   * Remove client from tracking
   */
  private removeClient(ws: AuthenticatedWebSocket) {
    if (!ws.userId) return;
    
    const userClients = this.clients.get(ws.userId);
    if (userClients) {
      userClients.delete(ws);
      if (userClients.size === 0) {
        this.clients.delete(ws.userId);
      }
    }
  }
  
  /**
   * Broadcast event to specific user
   */
  public broadcastToUser(userId: string, event: WebSocketEvent) {
    const userClients = this.clients.get(userId);
    if (!userClients) return;
    
    const message = JSON.stringify(event);
    
    userClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
  
  /**
   * Broadcast event to all clients in a thread
   */
  public broadcastToThread(threadId: string, event: WebSocketEvent, excludeUserId?: string) {
    const message = JSON.stringify(event);
    
    this.wss.clients.forEach((client) => {
      const ws = client as AuthenticatedWebSocket;
      if (
        ws.readyState === WebSocket.OPEN &&
        ws.threadId === threadId &&
        ws.userId !== excludeUserId
      ) {
        ws.send(message);
      }
    });
  }
  
  /**
   * Broadcast message received event
   */
  public emitMessageReceived(event: Omit<MessageReceivedEvent, 'timestamp'>) {
    const fullEvent: MessageReceivedEvent = {
      ...event,
      timestamp: new Date(),
    };
    
    // Broadcast to thread
    this.broadcastToThread(event.data.threadId, fullEvent);
    
    // Also notify user directly
    this.broadcastToUser(event.userId, fullEvent);
  }
  
  /**
   * Broadcast entity created event
   */
  public emitEntityCreated(event: Omit<EntityCreatedEvent, 'timestamp'>) {
    const fullEvent: EntityCreatedEvent = {
      ...event,
      timestamp: new Date(),
    };
    
    this.broadcastToUser(event.userId, fullEvent);
  }
  
  /**
   * Broadcast branch created event
   */
  public emitBranchCreated(event: Omit<BranchCreatedEvent, 'timestamp'>) {
    const fullEvent: BranchCreatedEvent = {
      ...event,
      timestamp: new Date(),
    };
    
    // Broadcast to parent thread
    const thread = event.data.thread;
    if (thread.parentThreadId) {
      this.broadcastToThread(thread.parentThreadId, fullEvent);
    }
    
    this.broadcastToUser(event.userId, fullEvent);
  }
  
  /**
   * Heartbeat to detect dead connections
   */
  private startHeartbeat() {
    setInterval(() => {
      this.wss.clients.forEach((client) => {
        const ws = client as AuthenticatedWebSocket;
        
        if (ws.isAlive === false) {
          this.removeClient(ws);
          return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // Every 30 seconds
  }
  
  /**
   * Get connection stats
   */
  public getStats() {
    return {
      totalClients: this.wss.clients.size,
      authenticatedUsers: this.clients.size,
      activeConnections: Array.from(this.clients.entries()).map(([userId, sockets]) => ({
        userId,
        connections: sockets.size,
      })),
    };
  }
}

// Singleton instance (will be initialized with HTTP server)
let wsServer: ChatWebSocketServer | null = null;

export function initializeWebSocketServer(server: any): ChatWebSocketServer {
  if (!wsServer) {
    wsServer = new ChatWebSocketServer(server);
  }
  return wsServer;
}

export function getWebSocketServer(): ChatWebSocketServer {
  if (!wsServer) {
    throw new Error('WebSocket server not initialized');
  }
  return wsServer;
}
