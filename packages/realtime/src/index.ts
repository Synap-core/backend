/**
 * Cloudflare Worker - Real-Time Notifications Service
 * 
 * This worker routes requests to the appropriate NotificationRoom Durable Object.
 * 
 * Routes:
 * - GET /rooms/:roomId/subscribe - Subscribe to notifications (WebSocket)
 * - POST /rooms/:roomId/broadcast - Broadcast notification to room
 * - GET /rooms/:roomId/health - Health check for room
 */

import { NotificationRoom } from './notification-room.js';

export interface Env {
  NOTIFICATION_ROOM: DurableObjectNamespace<NotificationRoom>;
}

/**
 * Main worker entry point
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Extract room ID from path: /rooms/:roomId/...
    const roomIdMatch = url.pathname.match(/^\/rooms\/([^/]+)\/(.+)$/);
    if (!roomIdMatch) {
      return new Response('Invalid path. Expected: /rooms/:roomId/:action', { status: 400 });
    }

    const [, roomId, action] = roomIdMatch;

    // Get or create Durable Object instance for this room
    const id = env.NOTIFICATION_ROOM.idFromName(roomId);
    const stub = env.NOTIFICATION_ROOM.get(id);

    // Route to appropriate action
    const newUrl = new URL(request.url);
    newUrl.pathname = `/${action}`;

    // Forward request to Durable Object
    return stub.fetch(new Request(newUrl, request));
  },
};
