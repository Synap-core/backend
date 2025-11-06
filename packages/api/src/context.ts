/**
 * tRPC Context
 * 
 * Simplified for local single-user MVP
 */

import { db } from '@synap/database';

export interface Context extends Record<string, unknown> {
  db: typeof db;
  authenticated: boolean;
}

export async function createContext(req: Request): Promise<Context> {
  // Check if request has valid token
  const authHeader = req.headers.get('Authorization');
  const expectedToken = process.env.SYNAP_SECRET_TOKEN;
  
  const authenticated = !expectedToken ? true : // No token = dev mode
    (authHeader?.startsWith('Bearer ') && authHeader.substring(7) === expectedToken);

  return {
    db,
    authenticated: authenticated || false,
  };
}

