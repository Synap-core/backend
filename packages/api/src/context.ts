/**
 * tRPC Context
 * 
 * PostgreSQL-only with Ory Kratos session authentication for multi-user support.
 */

import { getDb } from '@synap/database';
import { createLogger, InternalServerError } from '@synap/core';

const contextLogger = createLogger({ module: 'api-context' });

// Initialize database connection once at module load
let dbInstance: Awaited<ReturnType<typeof getDb>> | null = null;
async function getDbInstance() {
  if (!dbInstance) {
    dbInstance = await getDb();
  }
  return dbInstance;
}

export interface Context extends Record<string, unknown> {
  db: any; // Awaited<ReturnType<typeof getDb>>; // Fix TS2742
  authenticated: boolean;
  userId?: string | null;
  user?: any;
  session?: any;
  req?: Request;
}

export async function createContext(req: Request): Promise<Context> {
  // Initialize database
  const db = await getDbInstance();
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
      req,
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
        req,
      };
    }
    
    // No valid session
    return {
      db,
      authenticated: false,
      userId: null,
      user: null,
      session: null,
      req,
    };
  } catch (error) {
    contextLogger.error({ err: error }, 'Error getting session');
    return {
      db,
      authenticated: false,
      userId: null,
      user: null,
      session: null,
      req,
    };
  }
}

