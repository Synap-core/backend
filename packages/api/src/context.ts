/**
 * tRPC Context
 * 
 * PostgreSQL-only with Ory Kratos session authentication for multi-user support.
 */

import { getDb } from '@synap/database';
import { createLogger } from '@synap-core/core';
import { InternalServerError } from '@synap-core/types';

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
  socketIO?: any; // ✅ ADDED: Socket.IO server instance for real-time events
}

export async function createContext(req: Request): Promise<Context> {
  // Initialize database
  const db = await getDbInstance();

  // Use Ory Kratos session for authentication
  try {
    const authModule = await import('@synap/auth');
    if (!authModule.getSession) {
      throw new InternalServerError('getSession not available', { module: '@synap/auth' });
    }
    // Debug logging for cookie presence
    const cookieHeader = req.headers.get('cookie');
    contextLogger.info({ 
      hasCookie: !!cookieHeader, 
      cookieLength: cookieHeader?.length || 0 
    }, 'Attempting to get session from request');

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
    contextLogger.error({ 
      err: error,
      errorMessage: error instanceof Error ? error.message : String(error),
      cookiePresent: !!req.headers.get('cookie'),
      cookieLength: req.headers.get('cookie')?.length || 0
    }, 'Error getting session (detailed debug)');
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

