/**
 * PostgreSQL Database Client
 * For cloud multi-tenant deployment (Phase 2)
 */

import { drizzle } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import { Pool } from '@neondatabase/serverless';
import * as schema from './schema/index.js';
import { createLogger } from '@synap/core';

const dbLogger = createLogger({ module: 'database-pg' });

// Create connection pool - use process.env to avoid circular dependency
// Config can be used in higher-level packages, but database client should be low-level
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Create Drizzle instance
export const db = drizzle(pool, { schema });

/**
 * Set current user for Row-Level Security (RLS)
 * 
 * This function uses parameterized queries to prevent SQL injection.
 * 
 * @param userId - User ID to set as current user
 * @throws Error if userId is invalid or query fails
 * 
 * @example
 * ```typescript
 * await setCurrentUser('user-123');
 * // All subsequent queries will be filtered by RLS for this user
 * ```
 */
export async function setCurrentUser(userId: string): Promise<void> {
  if (!userId || typeof userId !== 'string') {
    throw new Error('Invalid userId: must be a non-empty string');
  }

  try {
    // Use parameterized query to prevent SQL injection
    await db.execute(sql`SET app.current_user_id = ${userId}`);
    dbLogger.debug({ userId }, 'RLS current user set');
  } catch (error) {
    dbLogger.error({ err: error, userId }, 'Failed to set RLS current user');
    throw new Error(`Failed to set current user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Clear current user for Row-Level Security (RLS)
 * 
 * Resets the RLS context, allowing queries without user filtering.
 * 
 * @example
 * ```typescript
 * await clearCurrentUser();
 * // RLS context cleared
 * ```
 */
export async function clearCurrentUser(): Promise<void> {
  try {
    await db.execute(sql`RESET app.current_user_id`);
    dbLogger.debug('RLS current user cleared');
  } catch (error) {
    dbLogger.error({ err: error }, 'Failed to clear RLS current user');
    throw new Error(`Failed to clear current user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

dbLogger.info('PostgreSQL database connected');

