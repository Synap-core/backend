/**
 * Session-token bootstrap (the credential the tRPC SDK consumes as `sessionToken`).
 *
 * Two steps, kept as separate functions so self-hosted callers can skip the
 * Control Plane entirely:
 *   1. `fetchHandshakeJwt()` — get a short-lived CP-signed handshake JWT (the CP hop).
 *   2. `handshake()`         — exchange that JWT at `POST {podUrl}/api/handshake`
 *                              for a Kratos session token.
 *
 * No client-side crypto — all signing is server-side; the client only relays
 * opaque tokens. Native `fetch` only.
 */

import {
  AuthBootstrapError,
  extractErrorMeta,
  readErrorBody,
} from "./errors.js";
import { assertValidPodUrl, normalizeUrl } from "./url.js";

export interface FetchHandshakeJwtOptions {
  /** Control Plane base URL, e.g. `https://api.synap.live`. */
  cpUrl: string;
  /** CP session token (Better-Auth). Sent as `Authorization: Bearer`. */
  cpToken: string;
  /** Pod URL the JWT will be audience-bound to. */
  podUrl: string;
  /** Override fetch (tests / edge runtimes). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 10000. */
  timeoutMs?: number;
}

/**
 * Get a CP-signed handshake JWT (`type:"handshake"`, `aud=podUrl`, ES256) via
 * `POST {cpUrl}/pods/handshake-jwt`. Self-hosted pods that mint their own
 * handshake JWT from a trusted issuer can skip this and pass that token straight
 * to `handshake()`.
 */
export async function fetchHandshakeJwt(
  opts: FetchHandshakeJwtOptions
): Promise<string> {
  assertValidPodUrl(opts.cpUrl);
  const cpUrl = normalizeUrl(opts.cpUrl);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${cpUrl}/pods/handshake-jwt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.cpToken}`,
    },
    body: JSON.stringify({ podUrl: opts.podUrl }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });

  if (!res.ok) {
    throw new AuthBootstrapError(
      `Could not get handshake JWT (HTTP ${res.status})`,
      res.status,
      { body: await readErrorBody(res) }
    );
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) {
    throw new AuthBootstrapError(
      "Handshake JWT response missing `token`",
      res.status,
      {
        body: data,
      }
    );
  }
  return data.token;
}

export interface HandshakeOptions {
  /** Pod base URL — no trailing slash, no `/api` suffix. Validated (https-only). */
  podUrl: string;
  /** CP-signed handshake JWT (from `fetchHandshakeJwt` or a self-hosted issuer). */
  handshakeToken: string;
  /** JWKS issuer URL to pin on the pod side. Defaults to the token's own `iss`. */
  issuerUrl?: string;
  /** Override fetch (tests / edge runtimes). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 15000. */
  timeoutMs?: number;
  /** Allow `http://` pod URLs (localhost / local-mode dev only). */
  allowHttp?: boolean;
}

export interface HandshakeResult {
  /** Kratos API session token. Pass as `sessionToken` to `createSynapClient`. */
  sessionToken: string;
  /** Raw Kratos session object when the pod returns it. */
  session?: { id?: string; active?: boolean; expires_at?: string };
  /**
   * Token expiry (ISO) when derivable from `session.expires_at`; otherwise
   * undefined — treat the token as opaque and re-handshake on the first 401.
   */
  expiresAt?: string;
}

/**
 * Exchange a CP handshake JWT for a pod Kratos session token via
 * `POST {podUrl}/api/handshake`. Throws `AuthBootstrapError` on failure; a 409
 * (identity already exists, no `session_token` in the body) becomes a typed
 * `ALREADY_EXISTS` error so the caller re-issues a JWT and retries.
 */
export async function handshake(
  opts: HandshakeOptions
): Promise<HandshakeResult> {
  assertValidPodUrl(opts.podUrl, { allowHttp: opts.allowHttp });
  const url = normalizeUrl(opts.podUrl);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${url}/api/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: opts.handshakeToken,
      ...(opts.issuerUrl ? { issuerUrl: opts.issuerUrl } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  if (res.status === 409) {
    throw new AuthBootstrapError(
      "Identity already exists on the pod; re-issue a handshake JWT and retry to obtain a session token",
      409,
      { code: "ALREADY_EXISTS", body: await readErrorBody(res) }
    );
  }

  if (!res.ok) {
    const body = await readErrorBody(res);
    const meta = extractErrorMeta(body);
    throw new AuthBootstrapError(
      `Pod handshake failed (HTTP ${res.status})`,
      res.status,
      {
        body,
        code: meta.code,
        setupRequired: meta.setupRequired,
      }
    );
  }

  const data = (await res.json()) as {
    success?: boolean;
    session?: { id?: string; active?: boolean; expires_at?: string };
    session_token?: string;
  };

  if (!data.session_token) {
    throw new AuthBootstrapError(
      "Handshake succeeded but no `session_token` was returned",
      res.status,
      { body: data }
    );
  }

  return {
    sessionToken: data.session_token,
    session: data.session,
    expiresAt: data.session?.expires_at,
  };
}
