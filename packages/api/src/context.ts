/**
 * tRPC Context
 * 
 * PostgreSQL-only with Ory Kratos session authentication for multi-user support.
 */

import { db } from '@synap/database';
import { createLogger, InternalServerError } from '@synap/core';

const contextLogger = createLogger({ module: 'api-context' });

export interface Context extends Record<string, unknown> {
  db: typeof db;
  authenticated: boolean;
  userId?: string | null;
  user?: any;
  session?: any;
}

export async function createContext(req: Request): Promise<Context> {
  // DEV MODE ONLY: Allow bypassing auth for testing
  // Check for x-test-user-id header
  const testUserId = req.headers.get('x-test-user-id');
  if (process.env.NODE_ENV === 'development' && testUserId) {
    contextLogger.debug({ testUserId }, 'Using dev-mode auth bypass');
    return {
      db,
      authenticated: true,
      userId: testUserId,
      user: {
        id: testUserId,
        email: 'test@example.com',
        name: 'Test User',
      },
      session: { identity: { id: testUserId } },
    };
  }

  // Use Ory Kratos session for authentication
  try {
    const authModule = await import('@synap/auth');
    if (!authModule.getSession) {
      throw new InternalServerError('getSession not available', { module: '@synap/auth' });
    }
    const session = await authModule.getSession(req.headers);
    
    // Kratos session structure: { identity: { id, traits: { email, name } } }
    if (session && session.identity) {
      return {
        db,
        authenticated: true,
        userId: session.identity.id,
        user: {
          id: session.identity.id,
          email: session.identity.traits.email,
          name: session.identity.traits.name,
        },
        session,
      };
    }
    
    // No valid session
    return {
      db,
      authenticated: false,
      userId: null,
      user: null,
      session: null,
    };
  } catch (error) {
    contextLogger.error({ err: error }, 'Error getting session');
    return {
      db,
      authenticated: false,
      userId: null,
      user: null,
      session: null,
    };
  }
}

