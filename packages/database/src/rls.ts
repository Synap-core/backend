/**
 * RLS Session Management
 *
 * Provides utilities to set PostgreSQL session variables for RLS policies.
 * Event handlers use this to operate within user context.
 */

import { db } from "./index.js";
import { sql } from "drizzle-orm";

/**
 * Execute a database operation with RLS context set
 *
 * @example
 * await withRLSContext(userId, async () => {
 *   return await db.query.entities.findMany();
 * });
 */
export async function withRLSContext<T>(
  userId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    // Set session variable for RLS policies
    await tx.execute(sql`SET LOCAL app.user_id = ${userId}`);

    // Execute callback within this session
    return await callback();
  });
}

/**
 * Execute a database operation with public (unauthenticated) context
 * Used for public link access
 */
export async function withPublicContext<T>(
  callback: () => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.user_id = 'public'`);
    return await callback();
  });
}

/**
 * Execute a database operation WITHOUT RLS context
 * Used by event handlers that validate permissions themselves
 *
 * IMPORTANT: Only use this in event handlers after permission validation!
 */
export async function withoutRLSContext<T>(
  callback: () => Promise<T>,
): Promise<T> {
  // Event handlers bypass RLS because:
  // 1. They validate permissions before persisting
  // 2. RLS only controls SELECT, not INSERT/UPDATE/DELETE
  return await callback();
}
