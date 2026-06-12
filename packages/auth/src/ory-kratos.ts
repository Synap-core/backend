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
import { buildLocalSession, isLocalModeEnabled } from "./local-mode.js";

const kratosPublicUrl =
  process.env.KRATOS_PUBLIC_URL || "http://localhost:4433";
const kratosAdminUrl = process.env.KRATOS_ADMIN_URL || "http://localhost:4434";

// Public API (for user flows)
export const kratosPublic = new FrontendApi(
  new Configuration({
    basePath: kratosPublicUrl,
  })
);

// Admin API (for management)
export const kratosAdmin = new IdentityApi(
  new Configuration({
    basePath: kratosAdminUrl,
  })
);

/**
 * Get session from Kratos
 *
 * @param cookie - Session cookie from request
 * @returns Session data or null if invalid
 */
export async function getKratosSession(cookie: string): Promise<any | null> {
  // LOCAL MODE: resolve via the fixed local identity (no Kratos call)
  if (isLocalModeEnabled()) {
    return buildLocalSession();
  }

  // MOCK: In test mode with disabled OAuth, accept mock cookies
  if (
    process.env.NODE_ENV === "test" ||
    process.env.ENABLE_OAUTH2 === "false"
  ) {
    if (cookie.includes("mock-session-cookie")) {
      return {
        active: true,
        identity: {
          id: "test-user-id",
          traits: {
            email: "test@example.com",
            name: { first: "Test", last: "User" },
          },
        },
      };
    }
  }

  try {
    const { data: session } = await kratosPublic.toSession({ cookie });
    return session;
  } catch (error: any) {
    const status = error.response?.status as number | undefined;
    // 401/403 = session is genuinely invalid or expired — caller returns 401
    if (status === 401 || status === 403) {
      return null;
    }
    // Network error or Kratos unavailable — throw so caller can surface 503
    console.error(
      "[getKratosSession] Kratos unreachable or unexpected error:",
      {
        message: error.message,
        code: error.code,
        status,
        url: kratosPublicUrl,
      }
    );
    throw error;
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
  } catch {
    return null;
  }
}

/**
 * Get session from Kratos using an API session token (X-Session-Token header).
 * Used by Telegram Mini App and other API clients that authenticate via
 * Kratos API flows (which return session tokens, not cookies).
 */
export async function getKratosSessionByToken(
  token: string
): Promise<any | null> {
  // LOCAL MODE: resolve via the fixed local identity (no Kratos call)
  if (isLocalModeEnabled()) {
    return buildLocalSession();
  }

  try {
    const { data: session } = await kratosPublic.toSession({
      xSessionToken: token,
    });
    return session;
  } catch (error: any) {
    const status = error.response?.status as number | undefined;
    if (status === 401 || status === 403) {
      return null;
    }
    console.error(
      "[getKratosSessionByToken] Kratos unreachable or unexpected error:",
      {
        message: error.message,
        status,
        url: kratosPublicUrl,
      }
    );
    throw error;
  }
}

/**
 * Get session from Kratos using an ory_kratos_session cookie value.
 * Used by Electron browser clients that authenticate via Kratos browser flows
 * (which issue cookies, not API session tokens).
 */
export async function getKratosSessionByCookie(
  cookieValue: string
): Promise<any | null> {
  try {
    const { data: session } = await kratosPublic.toSession({
      cookie: `ory_kratos_session=${cookieValue}`,
    });
    return session;
  } catch (error: any) {
    const status = error.response?.status as number | undefined;
    if (status === 401 || status === 403) {
      return null;
    }
    console.error(
      "[getKratosSessionByCookie] Kratos unreachable or unexpected error:",
      {
        message: error.message,
        status,
        url: kratosPublicUrl,
      }
    );
    throw error;
  }
}

/**
 * Get session from request headers
 *
 * Checks both cookie-based auth (browser) and X-Session-Token header (API clients).
 *
 * @param headers - Request headers
 * @returns Session data or null if invalid
 */
export async function getSession(headers: Headers): Promise<any | null> {
  // Check X-Session-Token first (API clients like Telegram Mini App)
  const sessionToken = headers.get("x-session-token");
  if (sessionToken) {
    return getKratosSessionByToken(sessionToken);
  }

  // Fall back to cookie-based auth (browser)
  const cookie = headers.get("cookie") || "";
  return getKratosSession(cookie);
}
