/**
 * tRPC Client Configuration for Admin Dashboard
 *
 * Connects to the Synap backend API via tRPC.
 */

import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@synap/api";

// Create tRPC React client
// Note: TypeScript may show errors due to dynamic router registry, but types work correctly at runtime
export const trpc = createTRPCReact<AppRouter>();

// API URL from environment or default to localhost
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

// Dev mode: Auto-authenticate in development
const IS_DEV = import.meta.env.DEV;
const DEV_USER_ID = "admin-ui-dev-user";

// tRPC client configuration
export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_URL}/trpc`,
      headers() {
        const headers: Record<string, string> = {};

        // Dev mode: Use test user bypass (backend checks x-test-user-id header)
        if (IS_DEV) {
          headers["x-test-user-id"] = DEV_USER_ID;
        }

        // Production: Use actual auth token
        const token = localStorage.getItem("synap_token");
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }

        return headers;
      },
    }),
  ],
});
