/**
 * Ory Hydra Client - OAuth2 Server
 *
 * Handles:
 * - OAuth2 token management
 * - Client management
 * - Scope validation
 * - Token introspection
 */

import { Configuration, OAuth2Api } from "@ory/hydra-client";

const hydraPublicUrl = process.env.HYDRA_PUBLIC_URL || "http://localhost:4444";
const hydraAdminUrl = process.env.HYDRA_ADMIN_URL || "http://localhost:4445";

// Public API (for OAuth2 flows)
export const hydraPublic = new OAuth2Api(
  new Configuration({
    basePath: hydraPublicUrl,
  }),
);

// Admin API (for management) - OAuth2Api with admin URL
export const hydraAdmin = new OAuth2Api(
  new Configuration({
    basePath: hydraAdminUrl,
  }),
);

/**
 * Introspect OAuth2 token
 *
 * @param token - OAuth2 access token
 * @returns Token information or null if invalid
 */
export async function introspectToken(token: string): Promise<any | null> {
  try {
    const { data } = await hydraPublic.introspectOAuth2Token({
      token,
    });
    return data.active ? data : null;
  } catch (error) {
    return null;
  }
}

/**
 * Create OAuth2 client
 *
 * @param client - Client configuration
 * @returns Created client data
 */
export async function createOAuth2Client(client: {
  client_id: string;
  client_secret: string;
  grant_types: string[];
  response_types: string[];
  scope: string;
  redirect_uris: string[];
}) {
  const { data } = await hydraAdmin.createOAuth2Client({
    oAuth2Client: client,
  });
  return data;
}

/**
 * Get OAuth2 client by ID
 *
 * @param clientId - Client ID
 * @returns Client data or null if not found
 */
export async function getOAuth2Client(clientId: string): Promise<any | null> {
  try {
    const { data } = await hydraAdmin.getOAuth2Client({ id: clientId });
    return data;
  } catch (error) {
    return null;
  }
}

/**
 * Exchange token (Token Exchange flow)
 *
 * @param params - Token exchange parameters
 * @returns New access token
 */
export async function exchangeToken(_params: {
  subject_token: string;
  subject_token_type: string;
  client_id: string;
  client_secret: string;
  requested_token_type?: string;
  scope?: string;
}): Promise<{
  access_token: string;
  token_type: string;
  expires_in: number;
} | null> {
  try {
    // Note: Hydra doesn't have a direct token exchange endpoint in the client
    // This would need to be implemented via the Admin API or a custom endpoint
    // For now, this is a placeholder
    throw new Error(
      "Token Exchange not yet fully implemented - needs custom endpoint",
    );
  } catch (error) {
    return null;
  }
}
