/**
 * tRPC Context
 * 
 * Multi-dialect support:
 * - SQLite: Static token authentication (single-user)
 * - PostgreSQL: Better Auth session (multi-user)
 */

import { db } from '@synap/database';
import { createLogger } from '@synap/core';
import { config } from '@synap/core';

const contextLogger = createLogger({ module: 'api-context' });
const isPostgres = config.database.dialect === 'postgres';

export interface Context extends Record<string, unknown> {
  db: typeof db;
  authenticated: boolean;
  userId?: string | null;
  user?: any;
  session?: any;
}

export async function createContext(req: Request): Promise<Context> {
  if (isPostgres) {
    // PostgreSQL: Use Better Auth session
    try {
      const authModule = await import('@synap/auth');
      if (!authModule.getSession) {
        throw new Error('getSession not available');
      }
      const session = await authModule.getSession(req.headers);
      
      if (session && session.user) {
        return {
          db,
          authenticated: true,
          userId: session.user.id,
          user: session.user,
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
  } else {
    // SQLite: Static token authentication
    const authHeader = req.headers.get('Authorization');
    const expectedToken = process.env.SYNAP_SECRET_TOKEN;
    
    const authenticated = !expectedToken ? true : // No token = dev mode
      (authHeader?.startsWith('Bearer ') && authHeader.substring(7) === expectedToken);
    
    return {
      db,
      authenticated: authenticated || false,
      // No userId in single-user mode
    };
  }
}

