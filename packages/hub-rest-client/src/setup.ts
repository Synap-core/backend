/**
 * Pod setup and health utilities.
 *
 * These functions are the canonical implementations shared between
 * the Synap CLI and the Raycast extension. They use the native fetch API
 * and have zero Node.js-specific dependencies.
 */

import { HubApiError } from "./errors.js";
import type { AgentSetupResult, PodStatus } from "./types.js";

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
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
  agentType = "openclaw"
): Promise<AgentSetupResult> {
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
