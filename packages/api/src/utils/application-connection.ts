/**
 * Browser application-connection protocol helpers.
 *
 * A Pod owner reviews these values before they become durable. They are not
 * CORS inputs and do not authorize data-plane access: their only job is to
 * bind a federation journey to an exact application callback without an open
 * redirect.
 */

import { createHash, randomBytes } from "node:crypto";

const CLIENT_ID_PATTERN = /^[a-z][a-z0-9._-]{2,127}$/;

export const APPLICATION_CONNECTION_SCOPES = [
  "auth:exchange-user",
  "identity:link-user",
] as const;

export type ApplicationConnectionScope =
  (typeof APPLICATION_CONNECTION_SCOPES)[number];

export function normalizeApplicationClientId(value: string): string | null {
  const candidate = value.trim();
  return CLIENT_ID_PATTERN.test(candidate) ? candidate : null;
}

function isExplicitLocalDevUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    (host === "localhost" || host === "127.0.0.1" || host === "::1") &&
    url.port.length > 0
  );
}

/**
 * Canonical origin registration. Production origins must be HTTPS. A local
 * browser app is allowed only on an explicit loopback host and port; there is
 * intentionally no wildcard, suffix, or scheme-less registration.
 */
export function normalizeApplicationOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.hostname.includes("*")
    ) {
      return null;
    }
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    const isHttps =
      url.protocol === "https:" && (!isLocal || isExplicitLocalDevUrl(url));
    const isDevHttp = url.protocol === "http:" && isExplicitLocalDevUrl(url);
    if (!isHttps && !isDevHttp) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * A callback may have a path and static query parameters, but must live on the
 * exact origin proposed by the application. We append only opaque request and
 * completion code values after owner approval.
 */
export function normalizeApplicationCallbackUrl(
  value: string,
  origin: string
): string | null {
  const normalizedOrigin = normalizeApplicationOrigin(origin);
  if (!normalizedOrigin) return null;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.hostname.includes("*") ||
      url.origin !== normalizedOrigin
    ) {
      return null;
    }
    const isLocal =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    const isHttps =
      url.protocol === "https:" && (!isLocal || isExplicitLocalDevUrl(url));
    const isDevHttp = url.protocol === "http:" && isExplicitLocalDevUrl(url);
    if (!isHttps && !isDevHttp) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizePublisherUrl(
  value: string | undefined
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.hostname.includes("*")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeApplicationConnectionScopes(
  values: readonly string[]
): ApplicationConnectionScope[] | null {
  const scopes = Array.from(new Set(values));
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope): scope is string =>
        !APPLICATION_CONNECTION_SCOPES.includes(
          scope as ApplicationConnectionScope
        )
    )
  ) {
    return null;
  }
  return scopes as ApplicationConnectionScope[];
}

/** SHA-256 is suitable because protocol secrets are random 256-bit values. */
export function hashOpaqueApplicationConnectionValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createOpaqueApplicationConnectionValue(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Build a callback solely from a URL that passed exact registration and owner
 * approval. It carries no Pod session, bearer token, or issuer assertion.
 */
export function buildApplicationConnectionCallbackUrl(input: {
  callbackUrl: string;
  requestId: string;
  code: string;
}): string {
  const url = new URL(input.callbackUrl);
  url.searchParams.set("connection_request", input.requestId);
  url.searchParams.set("connection_code", input.code);
  return url.toString();
}
