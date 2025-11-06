/**
 * Authentication Package
 * 
 * Local MVP: Simple static token auth
 * Cloud: Better Auth (Phase 2)
 */

export { authMiddleware, generateToken } from './simple-auth.js';

// For backward compatibility
export type Session = { authenticated: boolean };
export type User = { id: string; authenticated: boolean };

