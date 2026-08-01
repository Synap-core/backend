import { describe, it, expect } from "vitest";
import {
  classifyDispatchFailure,
  type FailureErrorClass,
} from "./external-dispatch.js";

/**
 * P1 "every failure carries a next action" — the SINGLE classifier's mapping,
 * pinned over a CORPUS of REAL dispatch-envelope failure shapes (not synthetic
 * one-liners). Each row is `{ status, error, errorCode }` exactly as a scheme
 * handler (nango/vault/mcp) in external-dispatch.ts returns it, so a drift in the
 * mapping — or in the reused `isConnectionAuthError` predicate — trips here.
 *
 * The auth rows include the LIVE dead-Google-connection envelopes observed on the
 * team pod (424 / 400, NOT 401/403) — proof the auth decision is message-driven
 * via `isConnectionAuthError`, not a naive status check that would miss them.
 */
type Shape = { status: number; error?: string; errorCode?: string };

const CORPUS: ReadonlyArray<
  readonly [label: string, shape: Shape, expected: FailureErrorClass]
> = [
  // ── auth (RECONNECT) ──────────────────────────────────────────────────────
  [
    "live: Nango refresh-token failure (424)",
    {
      status: 424,
      error:
        "Failed to get connection credentials: 'The external API returned an error when trying to refresh the access token. Please try again later.'",
      errorCode: "bad_request",
    },
    "auth",
  ],
  [
    "live: Nango connection_refresh_backoff (400)",
    {
      status: 400,
      error: "A recent refresh attempt failed. Backing off before retrying.",
      errorCode: "bad_request",
    },
    "auth",
  ],
  [
    "Google invalid_grant surfaced as 400",
    { status: 400, error: "invalid_grant", errorCode: "bad_request" },
    "auth",
  ],
  [
    "provider 401 Unauthorized (expired token)",
    { status: 401, error: "401 Unauthorized: access token expired" },
    "auth",
  ],
  [
    "provider 403 with an unauthorized credential signal",
    { status: 403, error: "unauthorized: the credential was revoked" },
    "auth",
  ],

  // ── no_connection (CONNECT) ───────────────────────────────────────────────
  [
    "nango: enabled but never connected (404)",
    {
      status: 404,
      error:
        'No connection found for provider "google". Ask the user to connect it in Settings → Connectors.',
      errorCode: "not_found",
    },
    "no_connection",
  ],
  [
    "vault-delegated: no Nango connection (404)",
    {
      status: 404,
      error: 'No Nango connection found for provider "gmail".',
      errorCode: "not_found",
    },
    "no_connection",
  ],

  // ── permission (grant / approval denial) ──────────────────────────────────
  [
    "vault grant check failed (403)",
    { status: 403, error: "Vault grant check failed: grant expired" },
    "permission",
  ],
  [
    "MCP server not approved (403)",
    {
      status: 403,
      error:
        'MCP server "notion" is not approved. An owner must approve it under Settings → MCP Servers before its tools can run.',
      errorCode: "bad_request",
    },
    "permission",
  ],

  // ── transient (RETRY) ─────────────────────────────────────────────────────
  [
    "provider rate-limited (429)",
    { status: 429, error: "rate limit exceeded", errorCode: "unavailable" },
    "transient",
  ],
  [
    "request timeout (408)",
    { status: 408, error: "upstream request timed out", errorCode: "unavailable" },
    "transient",
  ],
  [
    "Nango not configured (503)",
    { status: 503, error: "Nango not configured", errorCode: "unavailable" },
    "transient",
  ],
  [
    "outbound request failed (502)",
    { status: 502, error: "Outbound request failed: ECONNRESET", errorCode: "unavailable" },
    "transient",
  ],
  [
    "provider 500 whose body incidentally mentions a token (still RETRY, not reconnect)",
    { status: 500, error: "500 internal server error refreshing token" },
    "transient",
  ],

  // ── target_missing (a NOT_FOUND that is not a connection) ──────────────────
  [
    "vault secret deleted (404)",
    {
      status: 404,
      error: 'Vault secret "sec_123" could not be resolved (missing or deleted).',
      errorCode: "not_found",
    },
    "target_missing",
  ],
  [
    "no MCP server registered (404)",
    {
      status: 404,
      error: 'No MCP server found for "notion". Register it under Settings → MCP Servers first.',
      errorCode: "not_found",
    },
    "target_missing",
  ],
  [
    "tool not found for provider (404)",
    { status: 404, error: "Tool not found for provider: nango://gmail", errorCode: "not_found" },
    "target_missing",
  ],

  // ── provider (genuine provider-side failure) ──────────────────────────────
  [
    "Apify invalid API token (401-agnostic 4xx business error)",
    { status: 400, error: "Invalid API token provided.", errorCode: "bad_request" },
    "provider",
  ],
  [
    "unsupported provider scheme (400)",
    { status: 400, error: "Unsupported provider scheme. Got: foo://bar", errorCode: "bad_request" },
    "provider",
  ],
  [
    "provider 422 validation error",
    { status: 422, error: "Recipient email is malformed", errorCode: "bad_request" },
    "provider",
  ],
];

describe("classifyDispatchFailure — failure-class mapping over a real corpus", () => {
  for (const [label, shape, expected] of CORPUS) {
    it(`${label} → ${expected}`, () => {
      expect(
        classifyDispatchFailure({
          status: shape.status,
          message: shape.error,
          errorCode: shape.errorCode,
        })
      ).toBe(expected);
    });
  }

  it("precedence: 'no connection found' on a 404 is no_connection, never target_missing", () => {
    // isConnectionAuthError ALSO matches 'no connection found'; the classifier must
    // split it out BEFORE both the auth and target_missing branches.
    expect(
      classifyDispatchFailure({
        status: 404,
        message: 'No connection found for provider "x".',
        errorCode: "not_found",
      })
    ).toBe("no_connection");
  });

  it("precedence: a 5xx outranks an incidental auth word (RETRY, not RECONNECT)", () => {
    expect(
      classifyDispatchFailure({ status: 503, message: "token refresh service down" })
    ).toBe("transient");
  });

  it("empty/absent message on a plain 4xx → provider", () => {
    expect(classifyDispatchFailure({ status: 400 })).toBe("provider");
    expect(classifyDispatchFailure({ status: 400, message: "" })).toBe("provider");
  });
});
