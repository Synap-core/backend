/**
 * What a provider's connection brings into the pod — BEFORE the user connects
 * ("Brings events, contacts and the people you email").
 *
 * Derived, never hand-listed: the provider's capability template declares which
 * sync kinds its connection tool mirrors (`tools[].metadata.sync.kinds`, with
 * per-kind `enabled`), and the sync door's registry (`getSyncKinds`) says which
 * kinds are actually implemented and which profiles each writes. A kind appears
 * only when BOTH hold — a template kind with no handler would promise data that
 * is never synced; a handler the template does not enable is never run.
 */

import { createLogger } from "@synap-core/core";
import { fetchCPCapabilityTemplate } from "../services/capabilities/cp-template-client.js";
// Registers the Google kinds (side-effect imports) so the registry is populated
// in any process that reads it, not only where the sync runner was imported.
import "../services/event-sync/google-sync-kinds.js";
import { getSyncKinds } from "../services/event-sync/sync-kind-registry.js";
import { providerTemplateKey } from "./materialize-tools.js";

const logger = createLogger({ module: "connector-sync-kinds" });

export interface ProviderSyncKind {
  kind: string;
  profileSlugs: string[];
}

interface HandlerLike {
  kind: string;
  profileSlugs: string[];
  defaults: { enabled: boolean };
}

/** Pure: template definition × registered handlers → the kinds a connection brings. */
export function deriveProviderSyncKinds(
  provider: string,
  definition: unknown,
  handlers: ReadonlyArray<HandlerLike>
): ProviderSyncKind[] {
  const tools = ((definition as { tools?: unknown })?.tools ?? []) as Array<{
    credentialRef?: string | null;
    config?: { providerConfigKey?: string } | null;
    metadata?: {
      sync?: {
        enabled?: boolean;
        kinds?: Record<string, { enabled?: boolean }>;
      };
    } | null;
  }>;
  const tool = tools.find(
    (t) =>
      t.credentialRef === `nango://${provider}` ||
      t.config?.providerConfigKey === provider
  );
  const sync = tool?.metadata?.sync;
  if (!sync || sync.enabled !== true) return [];

  const out: ProviderSyncKind[] = [];
  for (const [kind, cfg] of Object.entries(sync.kinds ?? {})) {
    const handler = handlers.find((h) => h.kind === kind);
    if (!handler) continue;
    if (!(cfg?.enabled ?? handler.defaults.enabled)) continue;
    out.push({ kind, profileSlugs: [...handler.profileSlugs] });
  }
  return out;
}

/**
 * The sync kinds for each provider. A provider with no registered handler brings
 * nothing (`[]`, definitively). When the provider's template cannot be read the
 * entry is `undefined` — UNKNOWN, never an empty list that would read as "brings
 * nothing".
 */
export async function loadProviderSyncKinds(
  providers: string[]
): Promise<Map<string, ProviderSyncKind[] | undefined>> {
  const out = new Map<string, ProviderSyncKind[] | undefined>();
  for (const provider of new Set(providers)) {
    const handlers = getSyncKinds(provider);
    if (handlers.length === 0) {
      out.set(provider, []);
      continue;
    }
    try {
      const definition = await fetchCPCapabilityTemplate(
        providerTemplateKey(provider)
      );
      out.set(
        provider,
        definition
          ? deriveProviderSyncKinds(provider, definition, handlers)
          : undefined
      );
    } catch (err) {
      logger.warn(
        { err, provider },
        "Could not read the provider template for its sync kinds (reported as unknown)"
      );
      out.set(provider, undefined);
    }
  }
  return out;
}
