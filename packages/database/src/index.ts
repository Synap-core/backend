/**
 * Database Package - Main Export
 * Pure PostgreSQL with postgres.js
 */

// Export PostgreSQL clients
export { sql, db, getDb } from "./client-pg.js";

// Export RLS functions
export {
  setCurrentUser,
  clearCurrentUser,
  closeDatabase,
} from "./client-pg.js";

// Export all schemas
export * from "./schema/index.js";

// Export all repositories
export * from "./repositories/index.js";
export type { EventHook } from "./repositories/event-repository.js";
export type {
  VectorSearchParams,
  VectorSearchRow,
  VectorRepositoryDatabase,
} from "./repositories/vector-repository.js";
export { searchEntityVectorsRaw } from "./repositories/vector-repository.js";

// Export projectors (event handlers for materialized views)
export * from "./projectors/index.js";

// Export workspace permissions utilities
export * from "./utils/workspace-permissions.js";
export { PermissionError } from "./utils/workspace-permissions.js";

// Re-export commonly used drizzle-orm functions
export {
  // Query builders
  eq,
  and,
  or,
  not,
  sql as sqlTemplate, // Drizzle sql template tag
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
  // pgvector distance functions
  cosineDistance,
  l2Distance,
  innerProduct,
  // Types
  type SQL,
  type Column,
  getTableColumns,
} from "drizzle-orm";

// Also export sql from drizzle-orm as drizzleSql for clarity (for SQL template literals)
export { sql as drizzleSql } from "drizzle-orm";

// Also export as sqlDrizzle for even more clarity
export { sql as sqlDrizzle } from "drizzle-orm";

// Export postgres type for repositories that need raw SQL
export { type Sql } from "postgres";
