/**
 * Database Client - Pure PostgreSQL with postgres.js
 * 
 * Simple, single-driver approach for pod-per-user architecture.
 * Works everywhere: local development, cloud VMs, traditional hosting.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createLogger, ValidationError, InternalServerError } from '@synap-core/core';
import * as schema from './schema/index.js';

const logger = createLogger({ module: 'database' });


// Use DATABASE_URL from environment with correct fallback password
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:synap_dev_password@localhost:5432/synap';

logger.info({
  poolSize: 10,
  url: DATABASE_URL.replace(/:[^:@]+@/, ':***@'), // Hide password in logs
  msg: 'PostgreSQL connection pool initialized (postgres.js + Drizzle)'
});

// PostgreSQL connection configuration
const connectionConfig = {
  max: parseInt(process.env.DB_POOL_SIZE || '10'),      // Connection pool size
  idle_timeout: 20,                                      // Close idle connections after 20s
  connect_timeout: 10,                                   // Fail fast if DB unreachable
  onnotice: () => {},                                    // Suppress NOTICE messages
  debug: process.env.DB_DEBUG === 'true',                // Enable query logging if needed
};

/**
 * PostgreSQL connection pool (postgres.js)
 * 
 * Use this for raw SQL queries:
 * ```typescript
 * const result = await sql`SELECT * FROM users WHERE id = ${userId}`;
 * ```
 */
export const sql = postgres(DATABASE_URL, connectionConfig);

/**
 * Drizzle ORM instance (type-safe query builder)
 * 
 * Use this for type-safe queries:
 * ```typescript
 * const users = await db.select().from(usersTable).where(eq(usersTable.id, userId));
 * ```
 */
export const db = drizzle(sql, { schema });

/**
 * Get database instance (for compatibility with existing code)
 * @returns Drizzle database instance
 */
export async function getDb() {
  return db;
}

logger.info({
  poolSize: connectionConfig.max,
  url: process.env.DATABASE_URL?.substring(0, 30) + '...'
}, 'PostgreSQL connection pool initialized (postgres.js + Drizzle)');

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
    await sql`SELECT set_current_user(${userId}::text)`;
    logger.debug({ userId }, 'RLS current user set');
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to set RLS current user');
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
    await sql`RESET app.current_user_id`;
    logger.debug('RLS current user cleared');
  } catch (error) {
    logger.error({ err: error }, 'Failed to clear RLS current user');
    throw new InternalServerError(
      `Failed to clear current user: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { originalError: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Close database connections gracefully
 * Call this during application shutdown
 */
export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
  logger.info('Database connections closed');
}

// Handle process termination
process.on('SIGTERM', closeDatabase);
process.on('SIGINT', closeDatabase);
