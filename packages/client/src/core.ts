/**
 * Core RPC Client - Couche 1: Noyau Auto-Généré
 * 
 * This is the base tRPC client that provides direct, type-safe access
 * to all tRPC procedures via client.rpc.*
 */

import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from './types.js';

/**
 * Configuration for SynapClient
 */
export interface SynapClientConfig {
  /** Backend API URL (e.g., 'http://localhost:3000') */
  url: string;
  
  /** Token getter function (for authentication) */
  getToken?: () => Promise<string | null> | string | null;
  
  /** Static token (alternative to getToken, for simple cases) */
  token?: string;
  
  /** Additional headers to include in requests */
  headers?: Record<string, string>;
  
  /** Real-time WebSocket URL (optional, for realtime client) */
  realtimeUrl?: string;
}

/**
 * Create the core tRPC client
 * 
 * This is the foundation of the SDK - provides direct access to all tRPC procedures.
 */
export function createRPCClient(config: SynapClientConfig) {
  const links = [
    httpBatchLink({
      url: `${config.url}/trpc`,
      headers: async () => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...config.headers,
        };

        // Add authentication token
        let token: string | null = null;
        
        if (config.token) {
          token = config.token;
        } else if (config.getToken) {
          const result = await config.getToken();
          token = result || null;
        }

        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        return headers;
      },
    }),
  ];

  return createTRPCProxyClient<AppRouter>({
    links,
  });
}

