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
 */
import { TRPCError } from "@trpc/server";
import {
  validateExternalUrl,
  type SafePublicFetchDeps,
} from "@synap/shared-utils";

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
