/**
 * Push AI-provider configs to the Intelligence Service's per-customer provider
 * door (`/api/provider-config`).
 *
 * ONE door for "sync the ai_providers table → IS hot-reload", shared by the
 * tRPC router (routers/ai-providers.ts) and the Hub REST router
 * (routers/hub-protocol/rest/ai-providers.ts).
 *
 * Endpoint AND credential come from `resolveDefaultIntelligenceEndpoint()`
 * (the registered `intelligence_services` row — the pod's OWN IS key, sent as
 * `Authorization: Bearer`). The IS keys the config on that key's customer, so a
 * pod can only ever write its own row. The old shared-pool `PUT /admin/providers`
 * door (and the CP↔IS boot secret it needed) is no longer used by the pod.
 */

import {
  db,
  resolveDefaultIntelligenceEndpoint,
  resolveServiceKey,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "push-providers-to-is" });

export interface ISProviderEndpoint {
  /** IS base URL — DB `webhookUrl`, `INTELLIGENCE_HUB_URL` env as fallback. */
  endpoint: string;
  /** The pod's own IS API key (Bearer); empty string when unconfigured. */
  apiKey: string;
}

/** A call to the IS provider door that did not succeed. Never swallowed. */
export class ISProviderError extends Error {
  constructor(
    readonly code: "IS_NOT_CONFIGURED" | "IS_REJECTED",
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ISProviderError";
  }
}

/** Resolve the IS endpoint + the pod's own key. Shared by push and probe. */
export async function resolveISProviderEndpoint(): Promise<ISProviderEndpoint> {
  const { endpoint, apiKey } = await resolveDefaultIntelligenceEndpoint();
  return { endpoint, apiKey };
}

export interface ISProviderProbe {
  ok: boolean;
  models: string[];
  latencyMs: number;
  error?: string;
}

/**
 * Live-probe one of this pod's providers on the IS. Throws `ISProviderError`
 * on a missing key or any non-2xx answer; a probe that RAN and found the
 * provider unhealthy resolves with `ok: false`.
 */
export async function probeProviderOnIS(
  providerId: string
): Promise<ISProviderProbe> {
  const { endpoint, apiKey } = await resolveISProviderEndpoint();
  if (!apiKey) {
    throw new ISProviderError("IS_NOT_CONFIGURED", "IS not configured");
  }
  const res = await fetch(
    `${endpoint}/api/provider-config/${encodeURIComponent(providerId)}/test`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ISProviderError(
      "IS_REJECTED",
      `IS probe failed: ${res.status}${text ? ` ${text}` : ""}`,
      res.status
    );
  }
  return (await res.json()) as ISProviderProbe;
}

/**
 * Push the full ai_providers config to the active IS so it hot-reloads.
 *
 * Throws `ISProviderError` on a missing key or non-ok IS response, with the status + body text in the message
 * (no swallowed causes). Callers that treat the sync as best-effort (the CRUD
 * mutations, which must not roll back a committed DB write when the IS is down)
 * wrap this in try/catch + log; the explicit `sync` endpoint surfaces the same.
 */
export async function pushProvidersToIS(): Promise<void> {
  const { endpoint, apiKey } = await resolveISProviderEndpoint();
  if (!apiKey) {
    throw new ISProviderError(
      "IS_NOT_CONFIGURED",
      "IS provider sync skipped: no IS API key registered for this pod"
    );
  }

  const rows = await db.query.aiProviders.findMany({
    orderBy: (t, { asc }) => [asc(t.priority)],
  });

  const providers = rows.map((p) => {
    const decryptedKey = p.encryptedApiKey
      ? resolveServiceKey(p.encryptedApiKey, {
          column: "ai_providers.encrypted_api_key",
          rowId: p.id,
        })
      : undefined;

    return {
      id: p.providerId,
      name: p.name,
      baseUrl: p.baseUrl,
      apiKeyEnvVar: p.apiKeyEnvVar,
      ...(decryptedKey ? { apiKey: decryptedKey } : {}),
      enabled: p.enabled,
      priority: p.priority,
      tags: (p.tags as string[]) ?? [],
      models: (p.models as object[]) ?? [],
      ...(p.rateLimit ? { rateLimit: p.rateLimit } : {}),
      ...(p.extraBody ? { extraBody: p.extraBody } : {}),
      ...(p.systemPromptPrefix
        ? { systemPromptPrefix: p.systemPromptPrefix }
        : {}),
    };
  });

  const enabledIds = rows
    .filter((p) => p.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map((p) => p.providerId);

  const routing = {
    default: enabledIds[0] ?? "",
    fallbackChain: enabledIds,
    perRoute: {},
  };

  const res = await fetch(`${endpoint}/api/provider-config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ providers, routing }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ISProviderError(
      "IS_REJECTED",
      `IS provider sync failed: ${res.status} ${res.statusText}${
        text ? ` — ${text}` : ""
      }`,
      res.status
    );
  }

  logger.info({ count: providers.length }, "Providers synced to IS");
}
