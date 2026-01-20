/**
 * Context Types
 *
 * Proper type definitions for tRPC context to avoid `any` types.
 */

/**
 * Database client type
 *
 * Note: Using `any` here to preserve Drizzle's schema inference.
 * Attempting to use PostgresJsDatabase<any> loses the schema generic
 * and breaks db.query.tableName access patterns.
 */
export type DatabaseClient = any;

/**
 * Ory Kratos identity
 */
export interface KratosIdentity {
  id: string;
  traits: {
    email: string;
    name?: string;
    [key: string]: unknown;
  };
}

/**
 * Ory Kratos session
 */
export interface KratosSession {
  identity: KratosIdentity;
  active: boolean;
  expires_at?: string;
  authenticated_at?: string;
}

/**
 * User object (simplified from Kratos identity)
 */
export interface User {
  id: string;
  email: string;
  name?: string;
}

/**
 * Full tRPC context
 */
export interface Context {
  db: DatabaseClient;
  authenticated: boolean;
  userId?: string | null;
  user?: User | null;
  session?: KratosSession | null;
  req?: Request;
  socketIO?: any; // Socket.IO server instance (type: Server from 'socket.io')
}
