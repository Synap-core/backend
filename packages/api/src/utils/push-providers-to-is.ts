/**
 * Push AI-provider configs to the running Intelligence Service admin API.
 *
 * ONE door for "sync the ai_providers table → IS hot-reload", shared by the
 * tRPC router (routers/ai-providers.ts) and the Hub REST router
 * (routers/hub-protocol/rest/ai-providers.ts). Replaces two copy-pasted
 * sync-payload builders + fetch calls.
 *
 * Endpoint resolution is DB-first: intelligence_services.webhookUrl via
 * `resolveDefaultIntelligenceEndpoint()`, with the INTELLIGENCE_HUB_URL env var
 * only as the documented last-resort fallback (no DB row registered).
 *
 * Auth is a DELIBERATE exception to "IS credentials live in the DB": the IS
 * `/admin/*` routes authenticate with a *distinct* shared boot secret
 * (`X-Admin-Key` == the IS's own `ADMIN_API_KEY` / `INTELLIGENCE_HUB_INTERNAL_KEY`)
 * — NOT `intelligence_services.apiKey`, which is the IS→pod *callback* key. This
 * admin secret has no column in the DB, so it is sourced from env by design:
 * `INTELLIGENCE_HUB_INTERNAL_KEY ?? ADMIN_API_KEY`. Using the DB callback key
 * here would 401 against the admin API.
 */

import {
  db,
  resolveDefaultIntelligenceEndpoint,
  decryptServiceKey,
  isEncryptedServiceKey,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "push-providers-to-is" });

export interface ISAdminEndpoint {
  /** IS base URL — DB `webhookUrl`, `INTELLIGENCE_HUB_URL` env as fallback. */
  endpoint: string;
  /** Shared admin secret for `X-Admin-Key`; empty string when unconfigured. */
  adminKey: string;
}

/**
 * Resolve the IS admin endpoint (DB-first URL) + admin key (env shared secret).
 * Shared by the sync push and the per-provider live probe.
 */
export async function resolveISAdminEndpoint(): Promise<ISAdminEndpoint> {
  const { endpoint } = await resolveDefaultIntelligenceEndpoint();
  const adminKey =
    process.env.INTELLIGENCE_HUB_INTERNAL_KEY ??
    process.env.ADMIN_API_KEY ??
    "";
  return { endpoint, adminKey };
}

/**
 * Push the full ai_providers config to the active IS so it hot-reloads.
 *
 * Throws on a non-ok IS response, with the status + body text in the message
 * (no swallowed causes). Callers that treat the sync as best-effort (the CRUD
 * mutations, which must not roll back a committed DB write when the IS is down)
 * wrap this in try/catch + log; the explicit `sync` endpoint surfaces the same.
 */
export async function pushProvidersToIS(): Promise<void> {
  const { endpoint, adminKey } = await resolveISAdminEndpoint();
  if (!adminKey) {
    logger.warn("IS admin key not set — skipping provider sync");
    return;
  }

  const rows = await db.query.aiProviders.findMany({
    orderBy: (t, { asc }) => [asc(t.priority)],
  });

  const providers = rows.map((p) => {
    const decryptedKey =
      p.encryptedApiKey && isEncryptedServiceKey(p.encryptedApiKey)
        ? decryptServiceKey(p.encryptedApiKey)
        : (p.encryptedApiKey ?? undefined);

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

  const res = await fetch(`${endpoint}/admin/providers`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": adminKey,
    },
    body: JSON.stringify({ providers, routing }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `IS provider sync failed: ${res.status} ${res.statusText}${
        text ? ` — ${text}` : ""
      }`
    );
  }

  logger.info({ count: providers.length }, "Providers synced to IS");
}
