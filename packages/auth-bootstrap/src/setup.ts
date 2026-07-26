/**
 * Agent-setup + health primitives (the API-key bootstrap).
 *
 * Canonical home for `setupAgent` / `checkPodHealth`.
 *
 * ⚠️ `@synap/hub-rest-client` does NOT import from this package — it keeps its
 * own copy of `setupAgent`/`checkPodHealth` and of the `assertValidPodUrl` SSRF
 * guard (`hub-rest-client/src/setup.ts`), because that package is deliberately
 * zero-dependency. The two copies must be kept in sync — change one, change the
 * other. (Wave 2 of SDK-AND-BASE-APP-PLAN.md collapses them into one.)
 *
 * Native `fetch` only; zero runtime dependencies.
 */

import {
  AuthBootstrapError,
  extractErrorMeta,
  readErrorBody,
} from "./errors.js";
import { assertValidPodUrl, normalizeUrl } from "./url.js";

/** Result of `POST /api/hub/setup/agent`. */
export interface AgentSetupResult {
  hubApiKey: string;
  agentUserId: string;
  /** Null when no workspace was created/requested (the pod returns `id ?? null`). */
  workspaceId: string | null;
}

export interface PodStatus {
  url: string;
  healthy: boolean;
  version?: string;
}

/** Shared per-request knobs for the credential-bearing bootstrap calls. */
export interface BootstrapRequestOptions {
  /** Override fetch (tests / edge runtimes). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Allow `http://` pod URLs (localhost / local-mode dev only). */
  allowHttp?: boolean;
}

/**
 * Check whether a Synap pod is healthy. Best-effort: hits `GET {podUrl}/health`
 * and swallows errors, returning `healthy:false` rather than throwing.
 */
export async function checkPodHealth(
  podUrl: string,
  opts: Pick<BootstrapRequestOptions, "fetchImpl" | "timeoutMs"> = {}
): Promise<PodStatus> {
  const url = normalizeUrl(podUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const status: PodStatus = { url, healthy: false };

  try {
    const res = await doFetch(`${url}/health`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
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
 * Auth: `Authorization: Bearer <provisioningToken>` (the pod's `PROVISIONING_TOKEN`
 * for self-hosted, or an issuer-signed installation assertion for managed
 * pods).
 * Endpoint: `POST {podUrl}/api/hub/setup/agent`.
 */
export async function setupAgent(
  podUrl: string,
  provisioningToken: string,
  // REQUIRED (was defaulted to "openclaw"). The default silently minted every
  // bare caller onto the pod-wide `openclaw` agent-singleton (0037); with
  // OpenClaw removed that default is both dead and dangerous — a hidden omitter
  // would land on a stale/foreign singleton row. Required = any omitter is now a
  // COMPILE error that must name its agentType explicitly.
  agentType: string,
  opts: BootstrapRequestOptions = {}
): Promise<AgentSetupResult> {
  assertValidPodUrl(podUrl, { allowHttp: opts.allowHttp });
  const url = normalizeUrl(podUrl);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${url}/api/hub/setup/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provisioningToken}`,
    },
    body: JSON.stringify({ agentType }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    const meta = extractErrorMeta(body);
    throw new AuthBootstrapError(
      `Agent setup failed (HTTP ${res.status})`,
      res.status,
      {
        body,
        code: meta.code,
        setupRequired: meta.setupRequired,
      }
    );
  }

  return res.json() as Promise<AgentSetupResult>;
}
