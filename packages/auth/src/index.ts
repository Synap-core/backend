/**
 * Authentication Package
 *
 * Ory Stack (Kratos + Hydra) for PostgreSQL
 *
 * PostgreSQL-only authentication using Ory for multi-user support.
 */

// Re-export Ory Kratos (Identity Provider)
export {
  kratosPublic,
  kratosAdmin,
  getKratosSession,
  getIdentityById,
  getSession,
} from "./ory-kratos.js";

// Re-export Ory Hydra (OAuth2 Server)
export {
  hydraPublic,
  hydraAdmin,
  introspectToken,
  createOAuth2Client,
  getOAuth2Client,
  exchangeToken as hydraExchangeToken,
} from "./ory-hydra.js";

// Re-export Ory middleware
export { oryAuthMiddleware, orySessionMiddleware } from "./ory-middleware.js";

// Re-export Token Exchange
export { exchangeToken, exchangeBetterAuthToken } from "./token-exchange.js";

// Default exports (for PostgreSQL)
// These are used by the API server
export { orySessionMiddleware as authMiddleware } from "./ory-middleware.js";
// getSession is already exported above, no need to re-export

// Type exports (for compatibility)
export type { Session, User } from "./types.js";
