/**
 * Authentication Package
 * 
 * Conditional exports based on DB_DIALECT environment variable
 * Uses dynamic imports to avoid loading both auth implementations
 */

// Re-export simple auth (always available for backward compatibility)
export { authMiddleware as simpleAuthMiddleware, generateToken } from './simple-auth.js';

// Re-export Better Auth types (when available)
export type { Session, User } from './better-auth.js';

// Re-export better-auth exports for direct access
export { auth, betterAuthMiddleware, getSession } from './better-auth.js';

// The API server uses dynamic imports to conditionally load these
// For TypeScript compatibility, we export the better-auth versions as defaults
// The API server will override these with dynamic imports based on DB_DIALECT

// Export authMiddleware - default to better-auth (PostgreSQL)
// The API server will use dynamic imports to get the correct one
export { betterAuthMiddleware as authMiddleware } from './better-auth.js';
