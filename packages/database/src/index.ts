/**
 * Database Package - Main Export
 */

export * from './client.js';
export * from './schema/index.js';
export * from './repositories/index.js';
export type { EventHook } from './repositories/event-repository.js';

// Export RLS functions for PostgreSQL
export { setCurrentUser, clearCurrentUser } from './client-pg.js';

