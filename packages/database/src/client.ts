/**
 * Database client configuration
 * 
 * Default export uses SQLite for backward compatibility.
 * For runtime database selection, use the factory pattern:
 * 
 * @example
 * ```typescript
 * import { createDatabaseClient } from '@synap/database/factory';
 * const db = await createDatabaseClient();
 * ```
 * 
 * Or use the default export which selects based on DB_DIALECT:
 */

// Default: SQLite for backward compatibility
export * from './client-sqlite.js';

// Export factory for runtime database selection
export * from './factory.js';

