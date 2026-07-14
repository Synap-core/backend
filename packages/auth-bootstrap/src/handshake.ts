/**
 * Generic issuer-assertion exchange (the credential the tRPC SDK consumes as
 * `sessionToken`).
 *
 * An issuer-specific client obtains a short-lived signed assertion. This
 * package performs only the reusable, direct browser/client → Pod exchange at
 * `POST {podUrl}/api/federation/exchange`. The Pod derives the issuer from the
 * assertion and checks its own trusted-issuer registry; callers never send an
 * issuer URL or an external product identifier to the Pod.
 *
 * `fetchIssuerAssertion()` is a small convenience adapter for issuers that
 * expose an assertion endpoint. New integrations should use
 * `exchangeIssuerAssertion()` directly when they already hold an assertion.
 */

import {
  AuthBootstrapError,
  extractErrorMeta,
  readErrorBody,
} from "./errors.js";
import { assertValidPodUrl, normalizeUrl } from "./url.js";

export interface FetchIssuerAssertionOptions {
  /**
   * Issuer service base URL, e.g. `https://issuer.example`.
   */
  issuerUrl: string;
  /** Issuer-service session token, sent as `Authorization: Bearer`. */
  issuerToken: string;
  /** Pod URL the assertion will be audience-bound to. */
  podUrl: string;
  /** Override fetch (tests / edge runtimes). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 10000. */
  timeoutMs?: number;
}

/**
 * Request a generic user-exchange assertion from an issuer convenience API.
 * The returned assertion is still exchanged directly with the Pod.
 */
export async function fetchIssuerAssertion(
  opts: FetchIssuerAssertionOptions
): Promise<string> {
  assertValidPodUrl(opts.issuerUrl);
  const issuerUrl = normalizeUrl(opts.issuerUrl);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${issuerUrl}/pods/federation/assertion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.issuerToken}`,
    },
    body: JSON.stringify({ podUrl: opts.podUrl }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });

  if (!res.ok) {
    throw new AuthBootstrapError(
      `Could not get issuer assertion (HTTP ${res.status})`,
      res.status,
      { body: await readErrorBody(res) }
    );
  }

  const data = (await res.json()) as { assertion?: string };
  const assertion = data.assertion;
  if (!assertion) {
    throw new AuthBootstrapError(
      "Issuer assertion response missing `assertion`",
      res.status,
      {
        body: data,
      }
    );
  }
  return assertion;
}

/** @deprecated Use `FetchIssuerAssertionOptions`. */
export interface FetchHandshakeJwtOptions {
  cpUrl: string;
  cpToken: string;
  podUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** @deprecated Use `fetchIssuerAssertion()`. */
export async function fetchHandshakeJwt(
  opts: FetchHandshakeJwtOptions
): Promise<string> {
  return fetchIssuerAssertion({
    issuerUrl: opts.cpUrl,
    issuerToken: opts.cpToken,
    podUrl: opts.podUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export interface ExchangeIssuerAssertionOptions {
  /** Pod base URL — no trailing slash, no `/api` suffix. Validated (https-only). */
  podUrl: string;
  /** Short-lived assertion signed by an issuer trusted by this Pod. */
  assertion: string;
  /** Override fetch (tests / edge runtimes). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). Default 15000. */
  timeoutMs?: number;
  /** Allow `http://` pod URLs (localhost / local-mode dev only). */
  allowHttp?: boolean;
}

export interface ExchangeIssuerAssertionResult {
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
 * Exchange a generic issuer assertion for a direct Pod Kratos session token.
 * The assertion is sent directly to the Pod; it never returns to, or carries a
 * raw Pod session token through, the issuer service.
 */
export async function exchangeIssuerAssertion(
  opts: ExchangeIssuerAssertionOptions
): Promise<ExchangeIssuerAssertionResult> {
  assertValidPodUrl(opts.podUrl, { allowHttp: opts.allowHttp });
  const url = normalizeUrl(opts.podUrl);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${url}/api/federation/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assertion: opts.assertion }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    const meta = extractErrorMeta(body);
    throw new AuthBootstrapError(
      `Pod issuer assertion exchange failed (HTTP ${res.status})`,
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
      "Issuer assertion exchange succeeded but no `session_token` was returned",
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

/**
 * @deprecated Use `exchangeIssuerAssertion({ podUrl, assertion })`. This
 * wrapper intentionally does not forward `issuerUrl`: issuer selection is a
 * Pod-local trusted-issuer decision.
 */
export interface HandshakeOptions extends Omit<
  ExchangeIssuerAssertionOptions,
  "assertion"
> {
  handshakeToken: string;
  /** @deprecated Ignored. The Pod derives the issuer from the assertion. */
  issuerUrl?: string;
}

/** @deprecated Use `exchangeIssuerAssertion()`. */
export async function handshake(
  opts: HandshakeOptions
): Promise<ExchangeIssuerAssertionResult> {
  return exchangeIssuerAssertion({
    podUrl: opts.podUrl,
    assertion: opts.handshakeToken,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    allowHttp: opts.allowHttp,
  });
}

/** @deprecated Prefer `ExchangeIssuerAssertionResult`. */
export type HandshakeResult = ExchangeIssuerAssertionResult;
