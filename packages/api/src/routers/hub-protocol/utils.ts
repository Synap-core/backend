/**
 * Hub Protocol Utilities
 *
 * Shared utilities for creating tRPC callers to regular API endpoints
 */

import { getDb } from "@synap/database";
import type { Context } from "../../types/context.js";

/**
 * Create a tRPC caller context for Hub Protocol
 * This allows Hub Protocol to call regular API endpoints programmatically.
 * When calling workspace-scoped procedures (e.g. entities create/update),
 * pass workspaceId so the same event chain and validation apply.
 */
export async function createHubProtocolCallerContext(
  userId: string,
  scopes: string[],
  workspaceId?: string | null
): Promise<
  Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  }
> {
  const db = await getDb();

  const ctx: Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  } = {
    db,
    authenticated: true,
    userId,
    scopes,
    apiKeyId: "hub-protocol",
    apiKeyName: "Hub Protocol",
    req: null as any,
    user: null,
    session: null,
    workspaceId: workspaceId ?? null,
  };

  return ctx;
}
