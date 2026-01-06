/**
 * Ory Auth Middleware for Hono
 * 
 * Validates OAuth2 tokens from Hydra and extracts user identity from Kratos
 */

import type { MiddlewareHandler } from 'hono';
import { introspectToken } from './ory-hydra.js';
import { getIdentityById } from './ory-kratos.js';
import { getKratosSession } from './ory-kratos.js';

/**
 * Middleware for OAuth2 token authentication (Bearer tokens)
 * 
 * Used for API requests with OAuth2 tokens (from Hydra)
 */
export const oryAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.substring(7);
  
  // Introspect token with Hydra
  const tokenInfo = await introspectToken(token);
  
  if (!tokenInfo || !tokenInfo.active) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  // Get identity from Kratos
  const identity = await getIdentityById(tokenInfo.sub);
  
  if (!identity) {
    return c.json({ error: 'Identity not found' }, 401);
  }

  // Add to context
  c.set('user', {
    id: identity.id,
    email: identity.traits.email,
    name: identity.traits.name,
  });
  c.set('userId', identity.id);
  c.set('scopes', tokenInfo.scope?.split(' ') || []);
  c.set('authenticated', true);

  return next();
};

/**
 * Middleware for session-based authentication (Kratos sessions)
 * 
 * Used for browser-based requests with session cookies
 */
export const orySessionMiddleware: MiddlewareHandler = async (c, next) => {
  const cookie = c.req.header('cookie') || '';
  if (!cookie) {
    console.warn('[orySessionMiddleware] No cookie found. content-type:', c.req.header('content-type'), 'authorization:', !!c.req.header('authorization'));
    return c.json({ error: 'Unauthorized', details: 'No session cookie' }, 401);
  }

  // Get session from Kratos
  const session = await getKratosSession(cookie);
  
  if (!session || !session.identity) {
    console.warn('[orySessionMiddleware] Invalid session returned from Kratos', { 
      hasSession: !!session, 
      hasIdentity: !!session?.identity 
    });
    return c.json({ error: 'Invalid session' }, 401);
  }

  // Add to context
  c.set('user', {
    id: session.identity.id,
    email: session.identity.traits.email,
    name: session.identity.traits.name,
  });
  c.set('userId', session.identity.id);
  c.set('session', session);
  c.set('authenticated', true);

  return next();
};

