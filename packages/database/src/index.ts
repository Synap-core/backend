/**
 * Database Package - Main Export
 */

export * from './client.js';
export * from './schema/index.js';
export * from './repositories/index.js';
export type { EventHook } from './repositories/event-repository.js';

// Export RLS functions for PostgreSQL
export { setCurrentUser, clearCurrentUser } from './client-pg.js';

// Re-export commonly used drizzle-orm functions
// This ensures all packages use the same drizzle-orm instance
export {
  // Query builders
  eq,
  and,
  or,
  not,
  sql,
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
