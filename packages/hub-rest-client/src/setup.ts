/**
 * Pod setup and health utilities.
 *
 * These functions are the canonical implementations shared between
 * the Synap CLI and the Raycast extension. They use the native fetch API
 * and have zero Node.js-specific dependencies.
 *
 * ⚠️ `assertValidPodUrl` below is a DUPLICATE of the guard in
 * `@synap-core/auth-bootstrap` (`src/url.ts`). It is copied, not imported,
 * because this package is deliberately zero-dependency. The two copies must
 * be kept in sync — change one, change the other.
 */

import { HubApiError } from "./errors.js";
import type { AgentSetupResult, PodStatus } from "./types.js";

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

/** Shared per-request knobs for the credential-bearing bootstrap calls. */
export interface BootstrapRequestOptions {
  /** Allow `http://` pod URLs (localhost / local-mode dev only). */
  allowHttp?: boolean;
}

/**
 * Throws `HubApiError(status:0)` if `url` is not a valid http(s) pod origin:
 * must parse, be `https:` (or `http:` when `allowHttp`), and carry no embedded
 * credentials.
 *
 * `podUrl` is attacker-influenceable in multi-tenant / portal contexts, and the
 * bootstrap helpers POST bearer tokens to it — so every credential-bearing call
 * validates the URL first. Without this a caller could be coaxed into sending an
 * issuer assertion or provisioning token to an arbitrary host.
 *
 * Kept in sync with `@synap-core/auth-bootstrap`'s `assertValidPodUrl`.
 */
function assertValidPodUrl(
  url: string,
  opts: BootstrapRequestOptions = {}
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HubApiError(`Invalid pod URL: ${url}`, 0, {
      code: "INVALID_POD_URL",
    });
  }
  if (parsed.username || parsed.password) {
    throw new HubApiError("Pod URL must not contain embedded credentials", 0, {
      code: "INVALID_POD_URL",
    });
  }
  const isHttps = parsed.protocol === "https:";
  const isHttp = parsed.protocol === "http:";
  if (!isHttps && !(isHttp && opts.allowHttp)) {
    throw new HubApiError(
      `Pod URL must use https:// (got ${parsed.protocol}//)`,
      0,
      { code: "INSECURE_POD_URL" }
    );
  }
}

/**
 * Check whether a Synap pod is healthy.
 * Hits `GET {podUrl}/health` with a 5s timeout.
 */
export async function checkPodHealth(podUrl: string): Promise<PodStatus> {
  const url = normalizeUrl(podUrl);
  const status: PodStatus = { url, healthy: false };

  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      status.healthy = true;
      const data = (await res.json()) as Record<string, unknown>;
      status.version = data.version as string | undefined;
    }
  } catch {
    // pod unreachable or timed out
  }

  return status;
}

/**
 * Create an agent user + Hub Protocol API key on the pod.
 *
 * Auth: `Authorization: Bearer <provisioningToken>`
 * The provisioning token is either:
 *   - The pod's `PROVISIONING_TOKEN` env var (self-hosted path)
 *   - A CP-signed `agent_setup` JWT (managed pod path)
 *
 * Endpoint: `POST {podUrl}/api/hub/setup/agent`
 */
export async function setupAgent(
  podUrl: string,
  provisioningToken: string,
  agentType = "openclaw",
  opts: BootstrapRequestOptions = {}
): Promise<AgentSetupResult> {
  assertValidPodUrl(podUrl, { allowHttp: opts.allowHttp });
  const url = normalizeUrl(podUrl);

  const res = await fetch(`${url}/api/hub/setup/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provisioningToken}`,
    },
    body: JSON.stringify({ agentType }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new HubApiError(
      `Agent setup failed (HTTP ${res.status})`,
      res.status,
      body
    );
  }

  return res.json() as Promise<AgentSetupResult>;
}
