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
 * Attach an OIDC provider credential to an EXISTING Kratos identity.
 *
 * This is the missing wire behind silent federated sign-in: the pod records a
 * federated link in its own DB, but Kratos only completes an OIDC login without
 * a manual account-linking step if the identity actually carries the matching
 * `oidc` credential. Kratos has no "add one credential" admin endpoint, so we
 * fetch the identity WITH its credential configs, merge the new provider into
 * `oidc.config.providers`, and PUT the whole identity back — re-supplying the
 * existing `hashed_password` so the password credential is preserved, never
 * wiped. Idempotent: a provider+subject already present is a no-op.
 *
 * @returns { ok: true } on success (or already-linked), else a reason string.
 */
export async function attachOidcCredentialToIdentity(input: {
  kratosIdentityId: string;
  provider: string; // Kratos oidc provider id, e.g. "cp"
  subject: string; // the OIDC `sub` claim (the CP user id)
}): Promise<{ ok: boolean; reason?: string }> {
  const id = input.kratosIdentityId.trim();
  const provider = input.provider.trim();
  const subject = input.subject.trim();
  if (!id || !provider || !subject) {
    return { ok: false, reason: "missing-input" };
  }

  // 1. Read the identity WITH *every* credential config. Kratos redacts
  //    credential configs unless each type is named in `include_credential`,
  //    and (step 3) the PUT is a FULL REPLACE — any credential type absent from
  //    the body is DELETED. So we must fetch them ALL and re-supply them ALL, or
  //    attaching an oidc provider would silently strip the user's password AND
  //    their 2FA (totp / webauthn / lookup_secret) and passwordless `code`.
  const includeCredentials = [
    "password",
    "oidc",
    "totp",
    "webauthn",
    "lookup_secret",
    "code",
  ]
    .map((t) => `include_credential=${t}`)
    .join("&");
  const getRes = await fetch(
    `${kratosAdminUrl}/admin/identities/${encodeURIComponent(id)}?${includeCredentials}`,
    { signal: AbortSignal.timeout(8_000) }
  ).catch(() => null);
  if (!getRes?.ok) {
    return {
      ok: false,
      reason: `identity-fetch-failed:${getRes?.status ?? "network"}`,
    };
  }
  const identity = (await getRes.json().catch(() => null)) as {
    schema_id?: string;
    state?: string;
    traits?: unknown;
    metadata_public?: unknown;
    metadata_admin?: unknown;
    // A map keyed by credential method (password | oidc | totp | webauthn |
    // lookup_secret | code | …). Kept generic so unknown/future types round-trip
    // untouched instead of being dropped.
    credentials?: Record<string, { config?: Record<string, unknown> }>;
  } | null;
  if (!identity?.schema_id) {
    return { ok: false, reason: "identity-malformed" };
  }

  const credentials = identity.credentials ?? {};
  const oidcConfig = (credentials.oidc?.config ?? {}) as {
    providers?: Array<{ provider?: string; subject?: string }>;
  };
  const existingProviders = oidcConfig.providers ?? [];
  if (
    existingProviders.some(
      (p) => p.provider === provider && p.subject === subject
    )
  ) {
    return { ok: true }; // already linked — idempotent
  }

  const body = {
    schema_id: identity.schema_id,
    state: identity.state ?? "active",
    traits: identity.traits,
    ...(identity.metadata_public !== undefined
      ? { metadata_public: identity.metadata_public }
      : {}),
    ...(identity.metadata_admin !== undefined
      ? { metadata_admin: identity.metadata_admin }
      : {}),
    // Re-supply EVERY credential the identity carries (password hash, totp,
    // webauthn, lookup_secret, code, …) untouched, and splice only the new
    // provider into `oidc`. This is what stops the full-replace PUT from wiping
    // credentials it didn't explicitly know about.
    credentials: {
      ...credentials,
      oidc: {
        ...(credentials.oidc ?? {}),
        config: {
          ...oidcConfig,
          providers: [...existingProviders, { subject, provider }],
        },
      },
    },
  };

  const putRes = await fetch(
    `${kratosAdminUrl}/admin/identities/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    }
  ).catch(() => null);
  if (!putRes?.ok) {
    return {
      ok: false,
      reason: `identity-update-failed:${putRes?.status ?? "network"}`,
    };
  }
  return { ok: true };
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
  // Check X-Session-Token first (API clients like Telegram Mini App).
  const sessionToken = headers.get("x-session-token");
  if (sessionToken) {
    const tokenSession = await getKratosSessionByToken(sessionToken);
    if (tokenSession) return tokenSession;
    // A STALE/invalid token must NOT shadow a valid cookie. The browser always
    // sends X-Session-Token; if that token has expired while the Kratos cookie is
    // still good, returning null here would 401 a perfectly valid session — the
    // "proven (via cookie) but every /trpc 401s, forever" divergence + signout
    // loop. So fall through to cookie auth instead of short-circuiting. This makes
    // the function actually "check both", as its contract above promises.
  }

  // Cookie-based auth (browser) — primary for browser/Electron, and the fallback
  // when an X-Session-Token is present but no longer valid.
  const cookie = headers.get("cookie") || "";
  return getKratosSession(cookie);
}
