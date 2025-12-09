/**
 * Synap Provider
 * 
 * React context provider for Synap Client SDK
 * Wraps tRPC and QueryClient, provides hooks access
 */

'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCReact, httpBatchLink } from '@trpc/react-query';
import type { AppRouter } from '../types.js';

import { type CreateTRPCReact } from '@trpc/react-query';

// Create tRPC React hooks
const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

export interface SynapProviderConfig {
  /**
   * Data Pod URL
   * @default 'http://localhost:3000'
   */
  url?: string;
  
  /**
   * Token getter for authentication
   */
  getToken?: () => Promise<string | null> | string | null;
  
  /**
   * Additional headers
   */
  headers?: Record<string, string>;
  
  /**
   * Children to wrap
   */
  children: ReactNode;
}

interface SynapContextValue {
  api: typeof trpc;
  url: string;
}

const SynapContext = createContext<SynapContextValue | null>(null);

/**
 * Synap Provider Component
 * 
 * Wraps your app with tRPC and React Query providers
 * 
 * @example
 * ```tsx
 * <SynapProvider url="http://localhost:3000">
 *   <App />
 * </SynapProvider>
 * ```
 */
export function SynapProvider({ url = 'http://localhost:3000', getToken, headers, children }: SynapProviderConfig) {
  const queryClient = useMemo(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000, // 5 minutes
        retry: 1,
      },
    },
  }), []);
  
  const trpcClient = useMemo(() => trpc.createClient({
    links: [
      httpBatchLink({
        url: `${url}/trpc`,
        async headers() {
          const baseHeaders: Record<string, string> = {
            ...headers,
          };
          
          if (getToken) {
            const token = await getToken();
            if (token) {
              baseHeaders['Authorization'] = `Bearer ${token}`;
            }
          }
          
          return baseHeaders;
        },
        fetch(url, options) {
          return fetch(url, {
            ...options,
            credentials: 'include', // Send cookies
          });
        },
      }),
    ],
  }), [url, getToken, headers]);
  
  const contextValue = useMemo(() => ({
    api: trpc,
    url,
  }), [url]);
  
  return (
    <SynapContext.Provider value={contextValue}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </trpc.Provider>
    </SynapContext.Provider>
  );
}

/**
 * Hook to access Synap context
 * Must be used within SynapProvider
 */
export function useSynap(): SynapContextValue {
  const context = useContext(SynapContext);
  if (!context) {
    throw new Error('useSynap must be used within a SynapProvider');
  }
  return context;
}

/**
 * Hook to access the Synap tRPC client
 * Must be used within SynapProvider
 */
export function useSynapClient(): any {
  return useSynap().api;
}

// Export the trpc instance for direct use if needed
export { trpc };
