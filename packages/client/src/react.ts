/**
 * React Integration - Hooks for React applications
 * 
 * Provides React hooks for using Synap Client with React Query.
 */

import { createTRPCReact, type CreateTRPCReact } from '@trpc/react-query';
import { httpBatchLink, createTRPCProxyClient } from '@trpc/client';
import type { AppRouter } from './types.js';

/**
 * tRPC React client
 * 
 * Use this to create a React Query client with tRPC integration.
 * 
 * @example
 * ```typescript
 * import { trpc } from '@synap/client/react';
 * 
 * function MyComponent() {
 *   const { data } = trpc.notes.list.useQuery();
 *   const createNote = trpc.notes.create.useMutation();
 *   
 *   return (
 *     <div>
 *       {data?.map(note => <div key={note.id}>{note.title}</div>)}
 *     </div>
 *   );
 * }
 * ```
 */
export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>();

/**
 * Create a React Query client with tRPC integration
 * 
 * @example
 * ```typescript
 * import { createSynapReactClient } from '@synap/client/react';
 * import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
 * 
 * const queryClient = new QueryClient();
 * const trpcClient = createSynapReactClient({
 *   url: 'http://localhost:3000',
 *   getToken: async () => await getSessionToken(),
 * });
 * 
 * function App() {
 *   return (
 *     <trpc.Provider client={trpcClient} queryClient={queryClient}>
 *       <MyComponent />
 *     </trpc.Provider>
 *   );
 * }
 * ```
 */
export function createSynapReactClient(config: {
  url: string;
  getToken?: () => Promise<string | null> | string | null;
  token?: string;
  headers?: Record<string, string>;
}) {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${config.url}/trpc`,
        headers: async () => {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...config.headers,
          };

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
    ],
  });
}

// Re-export types
export type { AppRouter } from './types.js';

// Export new hooks and provider
export { SynapProvider, useSynap, useSynapClient } from './react/provider.js';
export { useEntities, useEntity, useEntitySearch, useCreateEntity, useUpdateEntity, useDeleteEntity } from './react/useEntities.js';
export { useThreads, useThread, useBranches, useSendMessage, useCreateBranch } from './react/useThreads.js';
export { useEvents, useAggregateEvents } from './react/useEvents.js';


