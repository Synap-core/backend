/**
 * Database Factory - Provider Selection
 * 
 * Creates the appropriate database client based on environment configuration.
 * 
 * Supported dialects:
 * - "sqlite" (default): SQLite for local single-user development
 * - "postgres": PostgreSQL for cloud multi-tenant deployment
 * 
 * Uses process.env directly to avoid circular dependencies with config.
 * Higher-level packages can use config, but database client remains low-level.
 */

// Type union for database client (using any for compatibility)
// In practice, these are Drizzle database instances with different dialects
export type DatabaseClient = any;

// Lazy import to avoid loading both clients at once
let _sqliteDb: DatabaseClient | null = null;
let _pgDb: DatabaseClient | null = null;

// Pre-import SQLite client for synchronous access
// This is safe because SQLite client doesn't have circular dependencies
let _sqliteModule: typeof import('./client-sqlite.js') | null = null;

/**
 * Get SQLite database client
 */
async function getSQLiteClient(): Promise<DatabaseClient> {
  if (!_sqliteDb) {
    const sqliteModule = await import('./client-sqlite.js');
    _sqliteModule = sqliteModule;
    _sqliteDb = sqliteModule.db;
  }
  return _sqliteDb;
}

/**
 * Get PostgreSQL database client
 */
async function getPostgresClient(): Promise<DatabaseClient> {
  if (!_pgDb) {
    const pgModule = await import('./client-pg.js');
    _pgDb = pgModule.db;
  }
  return _pgDb;
}

/**
 * Create database client based on environment configuration
 * 
 * @returns Configured database client instance
 * @throws Error if required environment variables are missing
 * 
 * @example
 * ```typescript
 * const db = await createDatabaseClient();
 * const users = await db.select().from(users);
 * ```
 */
export async function createDatabaseClient(): Promise<DatabaseClient> {
  const dialect = (process.env.DB_DIALECT || 'sqlite').toLowerCase();

  switch (dialect) {
    case 'postgres':
      if (!process.env.DATABASE_URL) {
        throw new Error('PostgreSQL requires DATABASE_URL environment variable');
      }
      return getPostgresClient();

    case 'sqlite':
      return getSQLiteClient();

    default:
      throw new Error(`Unknown database dialect: ${dialect}. Supported dialects: "sqlite", "postgres"`);
  }
}

/**
 * Get database client synchronously (for compatibility)
 * 
 * Note: This returns the default client based on current environment.
 * For SQLite, this is safe. For PostgreSQL, ensure DATABASE_URL is set.
 * 
 * @deprecated Use createDatabaseClient() for async initialization
 */
export function getDatabaseClient(): DatabaseClient {
  const dialect = (process.env.DB_DIALECT || 'sqlite').toLowerCase();

  if (dialect === 'postgres') {
    // PostgreSQL requires async initialization, but we'll try to use cached instance
    if (!_pgDb) {
      throw new Error('PostgreSQL client not initialized. Use createDatabaseClient() instead.');
    }
    return _pgDb;
  }

  // SQLite can be used synchronously
  if (!_sqliteDb) {
    // Import synchronously (SQLite only)
    // Use dynamic import but handle it synchronously for this deprecated function
    if (!_sqliteModule) {
      // This will fail in ES modules, but the function is deprecated anyway
      throw new Error(
        'SQLite client not pre-initialized. Use createDatabaseClient() for async initialization.'
      );
    }
    _sqliteDb = _sqliteModule.db;
  }

  return _sqliteDb;
}

/**
 * Get setCurrentUser function for the current database dialect
 * 
 * Only available for PostgreSQL (RLS support)
 */
export async function getSetCurrentUserFunction(): Promise<((userId: string) => Promise<void>) | null> {
  const dialect = (process.env.DB_DIALECT || 'sqlite').toLowerCase();

  if (dialect === 'postgres') {
    const pgModule = await import('./client-pg.js');
    return pgModule.setCurrentUser;
  }

  return null; // SQLite doesn't support RLS
}

/**
 * Get clearCurrentUser function for the current database dialect
 * 
 * Only available for PostgreSQL (RLS support)
 */
export async function getClearCurrentUserFunction(): Promise<((() => Promise<void>) | null)> {
  const dialect = (process.env.DB_DIALECT || 'sqlite').toLowerCase();

  if (dialect === 'postgres') {
    const pgModule = await import('./client-pg.js');
    return pgModule.clearCurrentUser;
  }

  return null; // SQLite doesn't support RLS
}

