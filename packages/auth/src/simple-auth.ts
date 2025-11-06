/**
 * Simple Static Token Authentication
 * 
 * For local single-user MVP
 * No session management, no OAuth, just a static secret token
 */

import type { Context, Next } from 'hono';

export interface AuthContext {
  authenticated: boolean;
}

/**
 * Middleware to validate static token
 */
export async function authMiddleware(c: Context, next: Next) {
  const expectedToken = process.env.SYNAP_SECRET_TOKEN;
  
  // If no token configured, allow all requests (dev mode)
  if (!expectedToken) {
    console.warn('⚠️  SYNAP_SECRET_TOKEN not set - authentication disabled!');
    return next();
  }
  
  // Get token from Authorization header
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header' }, 401);
  }
  
  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  
  // Validate token
  if (token !== expectedToken) {
    return c.json({ error: 'Unauthorized', message: 'Invalid token' }, 401);
  }
  
  // Token is valid, continue
  return next();
}

/**
 * Helper to generate a random token
 */
import { randomUUID } from 'crypto';

export function generateToken(): string {
  return randomUUID();
}

