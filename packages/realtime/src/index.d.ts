/**
 * Type definitions for Cloudflare Workers and Durable Objects
 */

export interface Env {
  NOTIFICATION_ROOM: DurableObjectNamespace;
}

export interface NotificationMessage {
  type: string;
  data: Record<string, unknown>;
  requestId?: string;
  timestamp?: string;
  status?: 'success' | 'error' | 'pending';
}

