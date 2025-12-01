/**
 * Universal Database Client
 * 
 * Automatically selects optimal driver:
 * - Local/Traditional Cloud: postgres.js (fast, simple)
 * - Serverless (Neon/Vercel): @neondatabase/serverless (WebSocket/HTTP)
 */

import { createDriver } from './driver-factory.js';
import type { DatabaseDriver } from './types.js';
import * as schema from './schema/index.js';
import { sql } from 'drizzle-orm';
import { createLogger, ValidationError, InternalServerError } from '@synap/core';

const dbLogger = createLogger({ module: 'database' });

// Lazy initialization
let driverInstance: DatabaseDriver | null = null;

/**
 * Get database instance (async initialization)
 * 
 * @example
 * const db = await getDb();
 * await db.select().from(users);
 */
export async function getDb() {
  if (!driverInstance) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    
    driverInstance = await createDriver({
      url: dbUrl,
      schema,
      poolSize: parseInt(process.env.DB_POOL_SIZE || '10'),
    });
  }
  return driverInstance.db;
}

/**
 * Synchronous database access (for compatibility)
 * 
 * Important: Call getDb() first to initialize!
 * 
 * @example
 * await getDb(); // Initialize
 * const users = await db.select().from(users); // Use synchronously
 */
export const db = new Proxy({} as any, {
  get(_target, prop) {
    if (!driverInstance) {
      throw new Error('Database not initialized. Call getDb() first.');
    }
    return driverInstance.db[prop];
  }
});

/**
 * Set current user for Row-Level Security (RLS)
 * 
 * @param userId - User ID to set as current user
 */
export async function setCurrentUser(userId: string): Promise<void> {
  if (!userId || typeof userId !== 'string') {
    throw new ValidationError('Invalid userId: must be a non-empty string', { userId });
  }

  try {
    const dbInstance = await getDb();
    await dbInstance.execute(sql`SELECT set_current_user(${userId}::text)`);
    dbLogger.debug({ userId }, 'RLS current user set');
  } catch (error) {
    dbLogger.error({ err: error, userId }, 'Failed to set RLS current user');
    throw new InternalServerError(
      `Failed to set current user: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { userId, originalError: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Clear current user for Row-Level Security (RLS)
 */
export async function clearCurrentUser(): Promise<void> {
  try {
    const dbInstance = await getDb();
    await dbInstance.execute(sql`RESET app.current_user_id`);
    dbLogger.debug('RLS current user cleared');
  } catch (error) {
    dbLogger.error({ err: error }, 'Failed to clear RLS current user');
    throw new InternalServerError(
      `Failed to clear current user: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { originalError: error instanceof Error ? error.message : String(error) }
    );
  }
}

dbLogger.info('Database client ready (lazy initialization)');
