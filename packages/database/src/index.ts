/**
 * Database Package - Main Export
 * Pure PostgreSQL with postgres.js
 */

// Export PostgreSQL clients
export { sql, db, getDb } from './client-pg.js';

// Export RLS functions
export { setCurrentUser, clearCurrentUser, closeDatabase } from './client-pg.js';

// Export all schemas
export * from './schema/index.js';

// Export all repositories
export * from './repositories/index.js';
export type { EventHook } from './repositories/event-repository.js';

// Re-export commonly used drizzle-orm functions
export {
  // Query builders
  eq,
  and,
  or,
  not,
  sql as sqlTemplate,        // Drizzle sql template tag
  // Comparison operators
  isNull,
  isNotNull,
  gt,
  gte,
  lt,
  lte,
  ne,
  // Array operators
  inArray,
  notInArray,
  // String operators
  like,
  notLike,
  ilike,
  notIlike,
  // Sorting
  asc,
  desc,
  // Types
  type SQL,
  type Column,
} from 'drizzle-orm';

// Also export sql from drizzle-orm as drizzleSql for clarity
export { sql as drizzleSql } from 'drizzle-orm';
