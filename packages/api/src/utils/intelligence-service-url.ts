/**
 * The one check a door runs before it stores or probes an intelligence
 * service URL (audit 2026-10-28, raw-fetch call sites).
 *
 * An `intelligence_services.webhookUrl` is fetched by ~40 downstream sites
 * (chat stream, OpenAI-compat, MCP, health checks) that trust the stored
 * value. So the URL is refused at the door that WRITES it, with the same
 * guard the Hub Protocol `services.register` door uses: `validateExternalUrl`
 * (scheme, a literal private / loopback / link-local / metadata address, a
 * single-label Docker service name such as `kratos` or `backend`, a trailing
 * dot). A registered service names its own port, so any port is allowed.
 *
 * The probes the registering doors send (`intelligence.ts`
 * `testCustomServiceConnection` / `registerCustomService`) go through the
 * pinned door `safePublicFetch` with {@link SERVICE_URL_FETCH}: a public name
 * that resolves to a private address is refused there too.
 *
 * Returns nothing: callers keep the URL as typed (`new URL()` would add a
 * trailing slash that `${url}/api/...` then doubles).
 *
 * Every later call to a resolved service goes through
 * {@link fetchIntelligenceService} (finding e90aa057): a check at write time
 * reads the URL text once, but the name is resolved at each call, so a public
 * name re-pointed at `10.x`, `169.254.169.254` or a dotted Docker name (DNS
 * rebinding), or a row written by a door that skipped the check (a sync peer),
 * would otherwise receive the service key on the pod's own network.
 */
import { TRPCError } from "@trpc/server";
import {
  safePublicFetch,
  validateExternalUrl,
  type SafePublicFetchDeps,
  type SafePublicFetchInit,
} from "@synap/shared-utils";
import { envIntelligenceEndpoint } from "./intelligence-routing.js";

/** A registered service URL names its own port (`https://is.example.com:3001`). */
export const SERVICE_URL_FETCH: SafePublicFetchDeps = { allowedPorts: "any" };

export function assertSafeServiceUrl(raw: string, field: string): void {
  const check = validateExternalUrl(raw, { allowedPorts: "any" });
  if (!check.valid) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${field} is not safe: ${check.reason}`,
    });
  }
}

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * THE door for a request to an intelligence service the pod resolved (the
 * routing ladder's `endpoint`, an `intelligence_services.webhookUrl`).
 *
 * - The OPERATOR's endpoint (`INTELLIGENCE_HUB_URL`, the env rung of the
 *   ladder) is configuration, not a URL from a person, an agent or a peer: it
 *   may name a private address on the pod's network (`http://10.10.0.20:3001`,
 *   a Docker service), so a request to exactly that origin is sent as is. This
 *   is the one exception, matched on the full origin (scheme, host, port), and
 *   it reaches nothing the env-rung client does not already reach.
 * - Every other URL is a registered service and goes through the pinned door
 *   `safePublicFetch` with {@link SERVICE_URL_FETCH}: each address the name
 *   resolves to must be public, the socket is pinned to the vetted one, and no
 *   redirect is followed (the key rides in a header). Decision d8bf5f0e.
 *
 * A refused request throws `BlockedOutboundError` (`isBlockedOutboundError`).
 * `deps` exists for tests (a resolver, an address rule).
 */
export async function fetchIntelligenceService(
  url: string,
  init: SafePublicFetchInit = {},
  deps: SafePublicFetchDeps = {}
): Promise<Response> {
  const operator = originOf(envIntelligenceEndpoint());
  if (operator !== null && originOf(url) === operator) {
    return fetch(url, {
      method: init.method,
      headers: init.headers,
      // Callers send a string (JSON); a streamed body is a pinned-door feature.
      body: init.body as RequestInit["body"],
      signal: init.signal,
    });
  }
  return safePublicFetch(url, init, 0, { ...SERVICE_URL_FETCH, ...deps });
}
