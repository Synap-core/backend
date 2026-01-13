/**
 * Ory Kratos Client - Identity Provider
 *
 * Handles:
 * - User registration/login
 * - OAuth flows (Google, GitHub)
 * - Session management
 * - Identity management
 */

import { Configuration, FrontendApi, IdentityApi } from "@ory/kratos-client";

const kratosPublicUrl =
  process.env.KRATOS_PUBLIC_URL || "http://localhost:4433";
const kratosAdminUrl = process.env.KRATOS_ADMIN_URL || "http://localhost:4434";

// Public API (for user flows)
export const kratosPublic = new FrontendApi(
  new Configuration({
    basePath: kratosPublicUrl,
  }),
);

// Admin API (for management)
export const kratosAdmin = new IdentityApi(
  new Configuration({
    basePath: kratosAdminUrl,
  }),
);

/**
 * Get session from Kratos
 *
 * @param cookie - Session cookie from request
 * @returns Session data or null if invalid
 */
export async function getKratosSession(cookie: string): Promise<any | null> {
  try {
    const { data: session } = await kratosPublic.toSession({
      cookie,
    });
    console.log(
      `[getKratosSession] Successfully validated session with Kratos at ${kratosPublicUrl}`,
    );
    return session;
  } catch (error: any) {
    console.error("[getKratosSession] Error validating session:", {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data,
      url: kratosPublicUrl,
    });
    return null;
  }
}

/**
 * Get identity by ID
 *
 * @param identityId - Identity ID
 * @returns Identity data or null if not found
 */
export async function getIdentityById(identityId: string): Promise<any | null> {
  try {
    const { data: identity } = await kratosAdmin.getIdentity({
      id: identityId,
    });
    return identity;
  } catch (error) {
    return null;
  }
}

/**
 * Get session from request headers
 *
 * @param headers - Request headers
 * @returns Session data or null if invalid
 */
export async function getSession(headers: Headers): Promise<any | null> {
  const cookie = headers.get("cookie") || "";
  return getKratosSession(cookie);
}
