/**
 * Authentication Package
 * 
 * Exports different auth systems based on DB_DIALECT:
 * - SQLite (local MVP): Simple static token auth
 * - PostgreSQL (SaaS): Better Auth with OAuth
 */

const isPostgres = process.env.DB_DIALECT === 'postgres';

if (isPostgres) {
  // PostgreSQL: Better Auth (multi-user with OAuth)
  export {
    auth,
    getSession,
    betterAuthMiddleware as authMiddleware,
  } from './better-auth.js';
  
  export type { Session, User } from './better-auth.js';
} else {
  // SQLite: Simple token auth (single-user)
  export {
    authMiddleware,
    generateToken,
  } from './simple-auth.js';
  
  // Type compatibility
  export type Session = { authenticated: boolean };
  export type User = { id: string; authenticated: boolean };
}

