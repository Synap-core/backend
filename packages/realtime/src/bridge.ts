/**
 * Socket.IO Bridge - HTTP Endpoint for Inngest Workers
 * 
 * Allows Inngest workers (running in separate process) to emit events
 * to Socket.IO clients via HTTP POST requests.
 * 
 * Workers POST to /bridge/emit → Socket.IO emits to connected clients
 */

import type { Server as SocketIOServer } from 'socket.io';
import type { IncomingMessage, ServerResponse } from 'http';

interface BridgeEmitRequest {
  event: string;
  workspaceId?: string;
  viewId?: string;
  userId?: string;
  data: any;
}

/**
 * Setup Socket.IO bridge HTTP endpoint
 */
export function setupBridge(io: SocketIOServer, httpServer: any) {
  console.log('[Bridge] Setting up HTTP endpoint...');
  
  // Intercept HTTP requests for bridge endpoints
  const originalListeners = httpServer.listeners('request').slice();
  httpServer.removeAllListeners('request');
  
  httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '';
    
    // Handle bridge endpoints
    if (url.startsWith('/bridge/')) {
      await handleBridgeRequest(io, req, res);
      return;
    }
    
    // Pass through to original handlers (Socket.IO)
    for (const listener of originalListeners) {
      listener(req, res);
    }
  });
  
  console.log('[Bridge] ✅ HTTP endpoint ready at /bridge/emit');
}

/**
 * Handle bridge HTTP requests
 */
async function handleBridgeRequest(
  io: SocketIOServer,
  req: IncomingMessage,
  res: ServerResponse
) {
  const url = req.url || '';
  
  // Health check
  if (url === '/bridge/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
    return;
  }
  
  // Emit endpoint
  if (url === '/bridge/emit' && req.method === 'POST') {
    await handleEmit(io, req, res);
    return;
  }
  
  // Not found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

/**
 * Handle event emission
 */
async function handleEmit(
  io: SocketIOServer,
  req: IncomingMessage,
  res: ServerResponse
) {
  try {
    // Parse request body
    const body = await parseBody(req);
    const { event, workspaceId, viewId, userId, data } = body as BridgeEmitRequest;
    
    // Validate required fields
    if (!event) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: event' }));
      return;
    }
    
    if (!workspaceId && !viewId && !userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        error: 'Must provide at least one of: workspaceId, viewId, userId' 
      }));
      return;
    }
    
    // Get presence namespace
    const presenceNamespace = io.of('/presence');
    
    // Emit to appropriate room(s)
    let emitCount = 0;
    
    if (workspaceId) {
      presenceNamespace.to(`workspace:${workspaceId}`).emit(event, data);
      emitCount++;
    }
    
    if (viewId) {
      presenceNamespace.to(`view:${viewId}`).emit(event, data);
      emitCount++;
    }
    
    if (userId) {
      presenceNamespace.to(`user:${userId}`).emit(event, data);
      emitCount++;
    }
    
    console.log(`[Bridge] Emitted '${event}' to ${emitCount} room(s)`, {
      workspaceId,
      viewId,
      userId,
    });
    
    // Success response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      success: true, 
      emitCount,
      event,
    }));
    
  } catch (error) {
    console.error('[Bridge] Error handling emit:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Parse request body
 */
function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (error) {
        reject(new Error('Invalid JSON'));
      }
    });
    
    req.on('error', reject);
  });
}
