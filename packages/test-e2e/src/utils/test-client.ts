/**
 * Test Client Factory
 * 
 * Creates tRPC clients for E2E testing
 */

import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@synap/api";
import fetch from "node-fetch";

export interface TestClientOptions {
  sessionCookie: string;
  apiUrl: string;
}

/**
 * Create a tRPC client for testing
 */
export function createTestClient(options: TestClientOptions) {
  const { sessionCookie, apiUrl } = options;

  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${apiUrl}/trpc`,
        headers: {
          Cookie: sessionCookie,
        },
        // @ts-ignore - node-fetch compatibility
        fetch: async (url, options) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000);
          try {
            const response = await fetch(url, {
              ...options,
              signal: controller.signal,
            });
            return response;
          } finally {
            clearTimeout(timeoutId);
          }
        },
      }),
    ],
  });
}

/**
 * Create multiple test clients for multi-user scenarios
 */
export function createMultiUserClients(
  users: Array<{ sessionCookie: string; id: string; email: string }>,
  apiUrl: string
) {
  return users.map((user) => ({
    ...user,
    trpc: createTestClient({ sessionCookie: user.sessionCookie, apiUrl }),
  }));
}
