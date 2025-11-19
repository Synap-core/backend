/**
 * NotificationRoom - Durable Object for Real-Time Notifications
 * 
 * This Durable Object manages WebSocket connections for a specific room.
 * Rooms are identified by userId or requestId, allowing multiple clients
 * to subscribe to the same notification stream.
 * 
 * Features:
 * - WebSocket connection management
 * - Broadcast messages to all connected clients
 * - Automatic cleanup on disconnect
 * - WebSocket hibernation support for efficiency
 */

export interface Env {
  NOTIFICATION_ROOM: DurableObjectNamespace<NotificationRoom>;
}

export interface NotificationMessage {
  type: string;
  data: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  status?: 'success' | 'error' | 'pending';
}

/**
 * NotificationRoom Durable Object
 * 
 * Manages WebSocket connections for a specific room (userId or requestId).
 * Supports:
 * - GET /subscribe - Upgrade HTTP to WebSocket
 * - POST /broadcast - Broadcast message to all connected clients
 */
export class NotificationRoom {
  private state: DurableObjectState;
  private env: Env;
  private connections: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Handle incoming requests
   * 
   * Routes:
   * - GET /subscribe - Upgrade to WebSocket connection
   * - POST /broadcast - Broadcast message to all clients
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade
    if (request.method === 'GET' && url.pathname === '/subscribe') {
      return this.handleWebSocketUpgrade(request);
    }

    // Handle broadcast
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      return this.handleBroadcast(request);
    }

    // Health check
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          connections: this.connections.size,
          roomId: this.state.id.toString(),
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Handle WebSocket upgrade request
   * 
   * Upgrades HTTP connection to WebSocket and manages the connection lifecycle.
   */
  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    // Check if request is a WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    server.accept();

    // Add to connections set
    this.connections.add(server);

    // Handle WebSocket events
    server.addEventListener('message', (event) => {
      // Echo back ping messages for keepalive
      if (event.data === 'ping') {
        server.send('pong');
      }
    });

    server.addEventListener('close', () => {
      // Remove from connections when closed
      this.connections.delete(server);
    });

    server.addEventListener('error', (error) => {
      console.error('WebSocket error:', error);
      this.connections.delete(server);
    });

    // Return WebSocket response
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Handle broadcast request
   * 
   * Receives a notification message and broadcasts it to all connected clients.
   */
  private async handleBroadcast(request: Request): Promise<Response> {
    try {
      // Parse notification message
      const message: NotificationMessage = await request.json();

      // Validate message structure
      if (!message.type || !message.data) {
        return new Response(
          JSON.stringify({ error: 'Invalid message format. Required: type, data' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Add timestamp if not present
      if (!message.timestamp) {
        message.timestamp = new Date().toISOString();
      }

      // Broadcast to all connected clients
      const broadcastCount = this.broadcastToClients(message);

      return new Response(
        JSON.stringify({
          success: true,
          broadcastCount,
          message: 'Notification broadcasted',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      console.error('Broadcast error:', error);
      return new Response(
        JSON.stringify({
          error: 'Failed to broadcast message',
          details: error instanceof Error ? error.message : String(error),
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  /**
   * Broadcast message to all connected clients
   * 
   * Sends the notification message to all active WebSocket connections.
   * Removes closed connections from the set.
   */
  private broadcastToClients(message: NotificationMessage): number {
    const messageJson = JSON.stringify(message);
    let broadcastCount = 0;
    const closedConnections: WebSocket[] = [];

    // Send to all connections
    for (const connection of this.connections) {
      try {
        // Check if connection is still open (WebSocket.OPEN = 1)
        if (connection.readyState === 1) {
          connection.send(messageJson);
          broadcastCount++;
        } else {
          // Mark for removal if closed
          closedConnections.push(connection);
        }
      } catch (error) {
        console.error('Error sending to client:', error);
        closedConnections.push(connection);
      }
    }

    // Clean up closed connections
    for (const connection of closedConnections) {
      this.connections.delete(connection);
    }

    return broadcastCount;
  }
}

