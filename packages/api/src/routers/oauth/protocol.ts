/**
 * OAuth 2.1 protocol core — storage-agnostic, dependency-free.
 *
 * Everything in this file is a pure function over its arguments: no database,
 * no `process.env`, no Hono, no Drizzle. That is deliberate. The control plane
 * runs the SAME protocol (see `synap-control-plane-api/src/lib/oauth.ts`), and
 * if the two implementations are ever unified into a shared package, THIS file
 * is the part that moves — the storage and identity halves live in `store.ts`
 * and `routes.ts` respectively and stay per-deployment.
 *
 * (Why the pod does not simply import the CP's implementation today: the CP is a
 * separate repo with its OWN pnpm workspace, so a shared package would have to
 * travel over npm publish + version pin — and the two ASs mint fundamentally
 * different tokens anyway. The CP signs an ES256 JWT; the pod's only bearer
 * model is an `api_keys` row. See the module header in `routes.ts`.)
 *
 * Specs implemented here:
 *   RFC 8414 — Authorization Server Metadata
 *   RFC 9728 — Protected Resource Metadata
 *   RFC 7591 — Dynamic Client Registration (validation half)
 *   RFC 7636 — PKCE (S256 only)
 */

import { createHash, timingSafeEqual } from "crypto";

// ─── Errors ──────────────────────────────────────────────────────────────────

/** RFC 6749 §5.2 token-endpoint / §4.1.2.1 authorize-endpoint error. */
export class OAuthError extends Error {
  constructor(
    public readonly code:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "invalid_scope"
      | "unauthorized_client"
      | "unsupported_grant_type"
      | "unsupported_response_type"
      | "access_denied"
      | "server_error",
    message: string
  ) {
    super(message);
    this.name = "OAuthError";
  }
  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

/** RFC 7591 §3.2.2 registration error. */
export class DcrError extends Error {
  constructor(
    public readonly code: "invalid_redirect_uri" | "invalid_client_metadata",
    message: string
  ) {
    super(message);
    this.name = "DcrError";
  }
  toJSON() {
    return { error: this.code, error_description: this.message };
  }
}

// ─── Issuer canonicality ─────────────────────────────────────────────────────

/**
 * Canonical issuer form. RFC 8414 §2 requires the metadata `issuer` to be the
 * exact string a client can concatenate paths onto and compare byte-for-byte,
 * so the same pod must never be spellable two ways: no credentials, no query,
 * no fragment, no trailing slash.
 *
 * This is the same rule `normalizeIssuerUrl` (utils/issuer-url-safety.ts)
 * enforces for INBOUND trusted issuers, with one deliberate difference: that
 * function is https-only because it guards an outbound JWKS fetch (an SSRF
 * surface). Here the issuer is the pod's OWN `PUBLIC_URL` and never becomes a
 * network target, so http is tolerated for loopback development only — and
 * `allowInsecureLoopback` must be false in production.
 */
export function canonicalizeIssuerUrl(
  rawUrl: string | undefined | null,
  opts: { allowInsecureLoopback?: boolean } = {}
): string | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return null;
  }
  if (parsed.protocol !== "https:") {
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]" ||
      parsed.hostname === "::1";
    if (!(
      opts.allowInsecureLoopback &&
      parsed.protocol === "http:" &&
      isLoopback
    )) {
      return null;
    }
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

// ─── Metadata documents ──────────────────────────────────────────────────────

/**
 * RFC 8414 authorization-server metadata.
 *
 * Every endpoint is derived from the SAME `issuer` string so the document is
 * self-consistent for a strict client (claude.ai refuses a document whose
 * `issuer` does not match the origin it fetched the document from).
 *
 * Deliberate omissions vs. the control plane's document:
 *   - `code_challenge_methods_supported` is S256 ONLY. OAuth 2.1 removes
 *     `plain`, and every client that reaches this AS is a public web client, so
 *     there is no legacy client to accommodate.
 *   - No `refresh_token` grant and no `offline_access` scope. The access token
 *     is an `api_keys` row with a fixed 90-day lifetime; when it expires the
 *     user re-authorizes. Advertising `offline_access` while never issuing a
 *     refresh token would be a lie a client acts on.
 */
export function buildAuthorizationServerMetadata(
  issuer: string,
  supportedScopes: readonly string[]
): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...supportedScopes],
  };
}

/**
 * RFC 9728 protected-resource metadata — the FIRST hop of claude.ai's discovery.
 *
 * A 401 from `<pod>/mcp` carries `WWW-Authenticate: Bearer resource_metadata=
 * "<pod>/.well-known/oauth-protected-resource"`. Claude fetches this document,
 * reads `authorization_servers[0]` (it uses ONLY the first entry), then fetches
 * that origin's RFC 8414 document. For Path B the pod is both the resource AND
 * the authorization server, so both fields are the same canonical issuer.
 */
export function buildProtectedResourceMetadata(
  issuer: string,
  supportedScopes: readonly string[]
): Record<string, unknown> {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    scopes_supported: [...supportedScopes],
  };
}

// ─── PKCE (RFC 7636) ─────────────────────────────────────────────────────────

/** base64url(sha256(verifier)) — the S256 challenge transform. */
export function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Constant-time string compare (avoids a timing oracle on secret material). */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hashing first makes both operands fixed-width so the compare is uniform.
  return timingSafeEqual(
    createHash("sha256").update(bufA).digest(),
    createHash("sha256").update(bufB).digest()
  );
}

/**
 * RFC 7636 §4.1: the verifier is 43–128 chars from the unreserved set. Checking
 * it here means a malformed verifier is rejected as `invalid_grant` rather than
 * silently hashing to something that cannot match.
 */
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Verify a PKCE code_verifier against a stored S256 challenge.
 *
 * Throws — never returns false — so a caller cannot forget to check the result.
 * A missing verifier is an error, not a skip: every code issued by this AS is
 * bound to a challenge (see `assertPkceChallenge`), so there is no
 * challenge-less path where the check could be legitimately absent. That
 * "absent challenge ⇒ skip PKCE" branch is exactly the hole this AS does not have.
 */
export function verifyPkce(
  storedChallenge: string,
  codeVerifier: string | null | undefined
): void {
  if (!codeVerifier) {
    throw new OAuthError("invalid_grant", "code_verifier is required");
  }
  if (!PKCE_VERIFIER_RE.test(codeVerifier)) {
    throw new OAuthError("invalid_grant", "Malformed code_verifier");
  }
  if (!constantTimeEqual(computeS256Challenge(codeVerifier), storedChallenge)) {
    throw new OAuthError("invalid_grant", "code_verifier mismatch");
  }
}

/**
 * Validate the PKCE parameters on an INCOMING authorize request. PKCE is
 * mandatory here (OAuth 2.1) and S256 is the only accepted method.
 */
export function assertPkceChallenge(
  codeChallenge: string | undefined,
  codeChallengeMethod: string | undefined
): string {
  if (!codeChallenge) {
    throw new OAuthError(
      "invalid_request",
      "code_challenge is required (PKCE S256)"
    );
  }
  // Absent method defaults to `plain` per RFC 7636 §4.3 — which this AS does not
  // support, so it must be sent explicitly as S256 rather than defaulted.
  if (codeChallengeMethod !== "S256") {
    throw new OAuthError(
      "invalid_request",
      "code_challenge_method must be S256"
    );
  }
  // base64url(sha256) is always 43 chars, unpadded.
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge)) {
    throw new OAuthError("invalid_request", "Malformed S256 code_challenge");
  }
  return codeChallenge;
}

// ─── Redirect URI ────────────────────────────────────────────────────────────

/**
 * Exact-match redirect validation. Byte-for-byte against the registered list —
 * NOT a prefix or origin comparison, either of which lets a registered
 * `https://good.example/cb` authorize `https://good.example/cb/../evil` or
 * `https://good.example.attacker.tld/cb`.
 */
export function isRegisteredRedirectUri(
  registered: readonly string[],
  candidate: string
): boolean {
  return registered.includes(candidate);
}

// ─── Scopes ──────────────────────────────────────────────────────────────────

/** RFC 6749 §3.3: scope is a space-delimited, order-insignificant list. */
export function parseScopeParam(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * Intersect requested scopes with what the client registered for.
 *
 * Unknown/unregistered scopes are DROPPED rather than rejected: claude.ai sends
 * a fixed scope string it uses across every connector, and failing the whole
 * authorization because one of them is unknown to this AS would break the flow
 * for a request the user genuinely made. An empty intersection falls back to
 * the client's registered set, which is already ⊆ what the pod supports.
 */
export function narrowScopes(
  registeredScopes: readonly string[],
  requested: readonly string[]
): string[] {
  if (requested.length === 0) return [...registeredScopes];
  const granted = requested.filter((s) => registeredScopes.includes(s));
  return granted.length > 0 ? granted : [...registeredScopes];
}

// ─── Dynamic Client Registration (RFC 7591) ──────────────────────────────────

/** Raw §3.1 registration request — every field untrusted until validated. */
export interface DcrRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
}

/** The validated, normalized metadata a store is safe to persist. */
export interface ValidatedClientMetadata {
  clientName: string;
  redirectUris: string[];
  scopes: string[];
}

/** §3.2.1 registration response. */
export interface DcrResponse {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  client_name: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string;
}

const DCR_MAX_REDIRECT_URIS = 8;
const DCR_MAX_CLIENT_NAME_LENGTH = 200;

/**
 * Validate an RFC 7591 §3.1 registration request.
 *
 * This endpoint is PUBLIC and unauthenticated, so validation is strict:
 *
 *   - redirect_uris: required, non-empty, absolute **https** only. No loopback
 *     allowance (RFC 8252's http-loopback carve-out is for native clients,
 *     which do not reach this web path) and no custom schemes.
 *   - token_endpoint_auth_method: "none" only. Every client of this AS is a
 *     PUBLIC client authenticated by PKCE; the pod never issues a client_secret,
 *     so accepting a confidential method would promise an authentication the
 *     token endpoint does not perform.
 *   - grant_types / response_types: authorization_code + code only.
 *   - scope: intersected with what the pod actually supports; unsupported
 *     entries are dropped, and an empty result falls back to the pod default.
 */
export function validateDcrRequest(
  req: DcrRequest,
  supportedScopes: readonly string[],
  defaultScopes: readonly string[]
): ValidatedClientMetadata {
  // ── redirect_uris ────────────────────────────────────────────────────────
  if (!Array.isArray(req.redirect_uris) || req.redirect_uris.length === 0) {
    throw new DcrError(
      "invalid_redirect_uri",
      "redirect_uris is required and must be a non-empty array"
    );
  }
  if (req.redirect_uris.length > DCR_MAX_REDIRECT_URIS) {
    throw new DcrError(
      "invalid_redirect_uri",
      `At most ${DCR_MAX_REDIRECT_URIS} redirect_uris may be registered`
    );
  }
  const redirectUris: string[] = [];
  for (const uri of req.redirect_uris) {
    if (typeof uri !== "string") {
      throw new DcrError(
        "invalid_redirect_uri",
        "Each redirect_uri must be a string"
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new DcrError("invalid_redirect_uri", `Not an absolute URI: ${uri}`);
    }
    if (parsed.protocol !== "https:") {
      throw new DcrError(
        "invalid_redirect_uri",
        `redirect_uri must use https: ${uri}`
      );
    }
    if (parsed.hash) {
      throw new DcrError(
        "invalid_redirect_uri",
        `redirect_uri must not contain a fragment: ${uri}`
      );
    }
    redirectUris.push(uri);
  }

  // ── token_endpoint_auth_method ───────────────────────────────────────────
  const authMethod =
    req.token_endpoint_auth_method === undefined
      ? "none"
      : req.token_endpoint_auth_method;
  if (authMethod !== "none") {
    throw new DcrError(
      "invalid_client_metadata",
      'Only token_endpoint_auth_method "none" is supported (public clients + PKCE)'
    );
  }

  // ── grant_types / response_types ─────────────────────────────────────────
  if (req.grant_types !== undefined) {
    if (
      !Array.isArray(req.grant_types) ||
      req.grant_types.some((g) => typeof g !== "string")
    ) {
      throw new DcrError(
        "invalid_client_metadata",
        "grant_types must be a string array"
      );
    }
    // `refresh_token` is tolerated in the REQUEST (claude.ai always asks) but is
    // not echoed back in the response — the AS only implements authorization_code.
    const unsupported = (req.grant_types as string[]).filter(
      (g) => g !== "authorization_code" && g !== "refresh_token"
    );
    if (unsupported.length > 0) {
      throw new DcrError(
        "invalid_client_metadata",
        `Unsupported grant_types: ${unsupported.join(", ")}`
      );
    }
    if (!(req.grant_types as string[]).includes("authorization_code")) {
      throw new DcrError(
        "invalid_client_metadata",
        "grant_types must include authorization_code"
      );
    }
  }
  if (req.response_types !== undefined) {
    if (
      !Array.isArray(req.response_types) ||
      req.response_types.some((t) => t !== "code")
    ) {
      throw new DcrError(
        "invalid_client_metadata",
        'response_types must be ["code"]'
      );
    }
  }

  // ── client_name ──────────────────────────────────────────────────────────
  // Untrusted display text: length-capped here, rendered as TEXT (never markup)
  // by the consent screen.
  let clientName = "Unnamed client";
  if (req.client_name !== undefined) {
    if (typeof req.client_name !== "string" || req.client_name.trim() === "") {
      throw new DcrError(
        "invalid_client_metadata",
        "client_name must be a non-empty string"
      );
    }
    clientName = req.client_name.trim().slice(0, DCR_MAX_CLIENT_NAME_LENGTH);
  }

  // ── scope ────────────────────────────────────────────────────────────────
  if (req.scope !== undefined && typeof req.scope !== "string") {
    throw new DcrError(
      "invalid_client_metadata",
      "scope must be a space-delimited string"
    );
  }
  const requested = parseScopeParam(req.scope as string | undefined);
  const scopes =
    requested.length === 0
      ? [...defaultScopes]
      : (() => {
          const kept = requested.filter((s) => supportedScopes.includes(s));
          return kept.length > 0 ? kept : [...defaultScopes];
        })();

  return { clientName, redirectUris, scopes };
}

/** Build the §3.2.1 response for a stored client. Public → no client_secret. */
export function buildDcrResponse(
  clientId: string,
  metadata: ValidatedClientMetadata,
  issuedAt: Date
): DcrResponse {
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
    redirect_uris: metadata.redirectUris,
    client_name: metadata.clientName,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: metadata.scopes.join(" "),
  };
}
