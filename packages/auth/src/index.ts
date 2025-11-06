/**
 * Authentication Package
 * 
 * Conditional exports based on DB_DIALECT environment variable
 */

// Re-export simple auth (always available for backward compatibility)
export { authMiddleware as simpleAuthMiddleware, generateToken } from './simple-auth.js';

// Re-export Better Auth types (when available)
export type { Session, User } from './better-auth.js';

// Default export based on environment
const isPostgres = process.env.DB_DIALECT === 'postgres';

// Export authMiddleware based on dialect
export const authMiddleware = isPostgres
  ? require('./better-auth.js').betterAuthMiddleware
  : require('./simple-auth.js').authMiddleware;

// Export auth instance (PostgreSQL only)
export const auth = isPostgres
  ? require('./better-auth.js').auth
  : null;

// Export getSession (PostgreSQL only)
export const getSession = isPostgres
  ? require('./better-auth.js').getSession
  : null;
