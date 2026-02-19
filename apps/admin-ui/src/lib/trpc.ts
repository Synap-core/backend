/**
 * tRPC Client Configuration for Admin Dashboard
 *
 * Connects to the Synap backend API via tRPC.
 * Auth: Kratos session cookies (same-domain, sent automatically).
 * Dev: x-test-user-id header bypass.
 */

import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@synap-core/api-types";
import SuperJSON from "superjson";

// Create tRPC React client
// Note: TypeScript may show errors due to dynamic router registry, but types work correctly at runtime
export const trpc = createTRPCReact<AppRouter>();

// API URL from environment or default to localhost
export const API_URL = import.meta.env.VITE_API_URL || "";

// Dev mode: Auto-authenticate in development
const IS_DEV = import.meta.env.DEV;
const DEV_USER_ID = "admin-ui-dev-user";

// tRPC client configuration
export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_URL}/trpc`,
      transformer: SuperJSON,
      headers() {
        const headers: Record<string, string> = {};

        // Dev mode: Use test user bypass (backend checks x-test-user-id header)
        if (IS_DEV) {
          headers["x-test-user-id"] = DEV_USER_ID;
        }

        // Workspace context — used by workspaceProcedure on the backend
        const workspaceId = localStorage.getItem("synap_workspace_id");
        if (workspaceId) {
          headers["X-Workspace-Id"] = workspaceId;
        }

        return headers;
      },
      // Send Kratos session cookies automatically (same-domain)
      fetch(url, options) {
        return fetch(url, { ...options, credentials: "include" });
      },
    }),
  ],
});
