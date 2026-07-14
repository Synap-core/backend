/**
 * @synap-core/auth-bootstrap
 *
 * Zero-dependency auth bootstrap for Synap data pods. The single home of the
 * two credential flows, imported by BOTH the tRPC SDK (`@synap-core/sdk`) and
 * the REST client (`@synap/hub-rest-client`):
 *
 *   - `exchangeIssuerAssertion()` → a Kratos session token (the tRPC SDK's
 *     `sessionToken`)
 *   - `setupAgent()` → a Hub Protocol API key   (the REST client's `apiKey`)
 *
 * Native `fetch` only — runs in Node >= 18, browsers, Deno, Bun, and edge.
 */

// Session-token flow (tRPC SDK)
export {
  exchangeIssuerAssertion,
  fetchIssuerAssertion,
  fetchHandshakeJwt,
  handshake,
} from "./handshake.js";
export type {
  ExchangeIssuerAssertionOptions,
  ExchangeIssuerAssertionResult,
  FetchIssuerAssertionOptions,
  HandshakeOptions,
  HandshakeResult,
  FetchHandshakeJwtOptions,
} from "./handshake.js";

// API-key flow (REST client)
export { setupAgent, checkPodHealth } from "./setup.js";
export type {
  AgentSetupResult,
  PodStatus,
  BootstrapRequestOptions,
} from "./setup.js";

// Errors + URL guard
export { AuthBootstrapError } from "./errors.js";
export type { AuthBootstrapErrorInit } from "./errors.js";
export { assertValidPodUrl, normalizeUrl } from "./url.js";
export type { AssertValidPodUrlOptions } from "./url.js";
