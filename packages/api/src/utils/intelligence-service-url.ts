/**
 * The one check a door runs before it stores or probes an intelligence
 * service URL (audit 2026-10-28, raw-fetch call sites).
 *
 * An `intelligence_services.webhookUrl` is fetched by ~40 downstream sites
 * (chat stream, OpenAI-compat, MCP, health checks) that trust the stored
 * value. So the URL is refused at the door that WRITES it, with the same
 * guard the Hub Protocol `services.register` door uses: `validateExternalUrl`
 * (scheme + loopback / private / link-local / metadata / internal Docker
 * service names). Deliberately not the DNS-pinned `safePublicFetch`: an
 * operator's own intelligence service may resolve to a private address on
 * the Docker network (`pinned-fetch.ts` says why).
 *
 * Returns nothing: callers keep the URL as typed (`new URL()` would add a
 * trailing slash that `${url}/api/...` then doubles).
 */
import { TRPCError } from "@trpc/server";
import { validateExternalUrl } from "@synap/shared-utils";

export function assertSafeServiceUrl(raw: string, field: string): void {
  const check = validateExternalUrl(raw);
  if (!check.valid) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${field} is not safe: ${check.reason}`,
    });
  }
}
