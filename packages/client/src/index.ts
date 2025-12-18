/**
 * @synap/client - Type-safe Client SDK for Synap
 * 
 * Direct tRPC client export with full type safety.
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
 * });
 * 
 * // Fully typed API calls
 * const entities = await client.entities.list.query({ limit: 20 });
 * const tag = await client.tags.create.mutate({ name: 'Important' });
 * ```
 */

import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@synap/api';

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
}

/**
 * Create a type-safe Synap API client
 * 
 * This client auto-syncs with the API's AppRouter type,
 * providing full autocomplete and type safety for all routes.
 * 
 * @param config - Client configuration
 * @returns Fully typed tRPC client
 * 
 * @example
 * ```typescript
 * // Basic usage
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
 * // With dynamic headers
 * const client = createSynapClient({
 *   url: 'https://api.synap.app',
 *   headers: async () => ({
 *     Authorization: `Bearer ${await getToken()}`,
 *   }),
 * });
 * ```
 */
export function createSynapClient(config: SynapClientConfig) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${config.url}/trpc`,
        headers: config.headers,
        fetch: config.fetch,
      }),
    ],
  });
}

/**
 * Type alias for the Synap TRP client
 */
export type SynapClient = ReturnType<typeof createSynapClient>;

// Re-export types for convenience
export type { AppRouter } from '@synap/api';
export type { TRPCClient } from '@trpc/client';

// Default export
export default createSynapClient;
