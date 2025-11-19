/**
 * tRPC Client Configuration for Admin Dashboard
 *
 * Connects to the Synap backend API via tRPC.
 */

import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@synap/api';

// Create tRPC React client
// Note: TypeScript may show errors due to dynamic router registry, but types work correctly at runtime
export const trpc = createTRPCReact<AppRouter>();

// API URL from environment or default to localhost
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// tRPC client configuration
export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_URL}/trpc`,
      // Add auth token if needed
      // headers() {
      //   const token = localStorage.getItem('auth_token');
      //   return token ? { Authorization: `Bearer ${token}` } : {};
      // },
    }),
  ],
});
