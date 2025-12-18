/**
 * @synap/client/react - React Query hooks for Synap
 * 
 * Provides tRPC React Query hooks with full type safety.
 * Auto-syncs with API changes via AppRouter type.
 * 
 * @example
 * ```typescript
 * import { createSynapReact, SynapProvider } from '@synap/client/react';
 * 
 * // Create hooks  
 * export const api = createSynapReact();
 * 
 * // In your app
 * function App() {
 *   return (
 *     <SynapProvider client={trpcClient} queryClient={queryClient}>
 *       <MyComponent />
 *     </SynapProvider>
 *   );
 * }
 * 
 * // In components
 * function MyComponent() {
 *   const { data } = api.entities.list.useQuery({ limit: 20 });
 *   const createTag = api.tags.create.useMutation();
 *   
 *   return <div>{data?.entities.map(...)}</div>;
 * }
 * ```
 */

import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '@synap/api';

/**
 * Create tRPC React hooks for Synap API
 * 
 * This provides fully typed React Query hooks that auto-sync
 * with the API's AppRouter type.
 * 
 * @example
 * ```typescript
 * // Create once in your app
 * export const api = createSynapReact();
 * 
 * // Use in components
 * function NotesScreen() {
 *   const { data, isLoading } = api.entities.list.useQuery({ 
 *     type: 'note',
 *     limit: 50 
 *   });
 *   
 *   const createEntity = api.entities.create.useMutation({
 *     onSuccess: () => {
 *       // Invalidate cache
 *       api.useContext().entities.list.invalidate();
 *     },
 *   });
 *   
 *   return (
 *     <div>
 *       {data?.entities.map(entity => (
 *         <div key={entity.id}>{entity.title}</div>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function createSynapReact(): ReturnType<typeof createTRPCReact<AppRouter>> {
  return createTRPCReact<AppRouter>();
}

/**
 * Type alias for the Synap tRPC React context
 */
export type SynapReactContext = ReturnType<typeof createSynapReact>;

// Re-export Provider and utilities from @trpc/react-query
// Re-export Provider from react-query (for setting up context)
export { QueryClientProvider as SynapQueryClientProvider } from '@tanstack/react-query';
export type { AppRouter } from '@synap/api';

// Default export
export default createSynapReact;
