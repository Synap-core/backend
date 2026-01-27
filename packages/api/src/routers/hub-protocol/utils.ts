/**
 * Hub Protocol Utilities
 *
 * Shared utilities for creating tRPC callers to regular API endpoints
 */

import { getDb } from "@synap/database";
import type { Context } from "../../types/context.js";

/**
 * Create a tRPC caller context for Hub Protocol
 * This allows Hub Protocol to call regular API endpoints programmatically
 */
export async function createHubProtocolCallerContext(
  userId: string,
  scopes: string[]
): Promise<
  Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  }
> {
  const db = await getDb();

  // Create context matching API key middleware structure
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
  };

  return ctx;
}
