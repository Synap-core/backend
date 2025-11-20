/**
 * Database client configuration
 * 
 * PostgreSQL only (with TimescaleDB + pgvector)
 * 
 * For direct access:
 * ```typescript
 * import { db } from '@synap/database';
 * const users = await db.select().from(users);
 * ```
 * 
 * For RLS (Row-Level Security):
 * ```typescript
 * import { setCurrentUser, clearCurrentUser } from '@synap/database';
 * await setCurrentUser('user-123');
 * // All queries filtered by RLS
 * await clearCurrentUser();
 * ```
 */

// Export PostgreSQL client as default
export * from './client-pg.js';
