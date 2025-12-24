/**
 * @synap/client - Type-safe Client SDK for Synap
 * 
 * Direct tRPC client export with full type safety + real-time WebSocket support.
 * Auto-syncs with API changes via AppRouter type.
 * 
 * @example
 * ```typescript
 * import { createSynapClient } from '@synap/client';
 * 
 * const client = createSynapClient({
 *   url: 'https://api.synap.app',
 *   headers: () => ({
 *     Authorization: `Bearer ${token}`,
 *   }),
 *   realtime: {
 *     userId: 'user-123',
 *     userName: 'Alice',
 *   },
 * });
 * 
 * // Fully typed API calls
 * const entities = await client.trpc.entities.list.query({ limit: 20 });
 * const tag = await client.trpc.tags.create.mutate({ name: 'Important' });
 * 
 * // Real-time collaboration
 * client.realtime?.connectPresence('view-id');
 * const ydoc = client.realtime?.connectYjs('view-id');
 * ```
 */

import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@synap/api';
import { createRealtimeClient, type RealtimeClient } from './realtime.js';

/**
 * Configuration for Synap client
 */
export interface SynapClientConfig {
  /** 
   * Base URL for the Synap API 
   * @example 'https://api.synap.app' or 'http://localhost:3000'
   */
  url: string;

  /**
   * Optional headers to include with every request
   * Can be a function for dynamic headers (e.g., authentication tokens)
   */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

  /**
   * Optional fetch implementation
   * Useful for React Native or custom fetch behavior
   */
  fetch?: typeof globalThis.fetch;
  
  /**
   * Real-time configuration (optional)
   * If provided, enables WebSocket-based real-time features
   */
  realtime?: {
    userId: string;
    userName: string;
  };
}

/**
 * Synap client return type
 */
export interface SynapClient {
  /** tRPC client for API calls */
  trpc: ReturnType<typeof createTRPCClient<AppRouter>>;
  /** Real-time client for WebSocket features (if configured) */
  realtime: RealtimeClient | null;
}

/**
 * Create a type-safe Synap API client
 * 
 * This client auto-syncs with the API's AppRouter type,
 * providing full autocomplete and type safety for all routes.
 * 
 * @param config - Client configuration
 * @returns Client with tRPC and realtime support
 * 
 * @example
 * ```typescript
 * // Basic usage (REST only)
 * const client = createSynapClient({
 *   url: 'https://api.synap.app',
 * });
 * 
 * // With authentication
 * const client = createSynapClient({
 *   url: 'https://api.synap.app',
 *   headers: {
 *     Authorization: `Bearer ${token}`,
 *   },
 * });
 * 
 * // With real-time support
 * const client = createSynapClient({
 *   url: 'https://api.synap.app',
 *   headers: async () => ({
 *     Authorization: `Bearer ${await getToken()}`,
 *   }),
 *   realtime: {
 *     userId: 'user-123',
 *     userName: 'Alice',
 *   },
 * });
 * ```
 */
export function createSynapClient(config: SynapClientConfig): SynapClient {
  // Create tRPC client
  const trpcClient = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${config.url}/trpc`,
        headers: config.headers,
        fetch: config.fetch,
      }),
    ],
  });
  
  // Create real-time client (if configured)
  const realtimeClient = config.realtime
    ? createRealtimeClient({
        url: config.url,
        auth: config.realtime,
      })
    : null;
  
  return {
    trpc: trpcClient,
    realtime: realtimeClient,
  };
}

// Re-export types for convenience
export type { AppRouter } from '@synap/api';
export type { TRPCClient } from '@trpc/client';
export type { RealtimeClient } from './realtime.js';

// Default export
export default createSynapClient;
