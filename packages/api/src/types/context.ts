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
  workspaceId?: string | null; // Workspace ID from X-Workspace-Id header
  workspaceRole?: string | null; // User's role in the workspace (set by workspaceProcedure)
  /**
   * Request source — "intelligence" when the request comes from the Intelligence Hub
   * via API key auth. Set automatically by api-key-auth middleware; never set by humans.
   */
  source?: string | null;
  /**
   * Hard flag — true only when authenticated via a hub-protocol scoped API key.
   * Cannot be spoofed by a human JWT session.
   */
  isHubProtocol?: boolean;
  /**
   * The message ID that triggered this hub-protocol request.
   * When set, proposals created during this request are linked to this message.
   */
  sourceMessageId?: string | null;
  /**
   * Session ID that triggered this hub-protocol request.
   * When set, proposals created during this request are linked to this session.
   */
  sessionId?: string | null;
}
