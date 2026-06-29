/**
 * Control-Plane capability-template client.
 *
 * The CP is the SINGLE source of truth for the capability-template catalog
 * (the same place workspace packages live). The pod does NOT carry templates —
 * it fetches definitions from the CP on demand (cached) and applies them. This
 * is what ends the per-pod template duplication / "hidden door" fragility.
 *
 * Source: GET {CP}/api/marketplace/capabilities → { capabilities: [...] }
 * (public read; see synap-control-plane-api/src/routes/marketplace-apps.ts).
 */

import type { CapabilityDefinition } from "@synap/playbooks";

export interface CPCapabilityTemplate {
  key: string;
  name: string;
  description?: string | null;
  connectionHint?: {
    required: boolean;
    type: "nango" | "vault" | "external" | "none";
    provider?: string;
  };
  definition: CapabilityDefinition;
}

/** Resolve the Control Plane base URL (mirrors cells.ts `getCpUrl`). */
function cpUrl(): string | null {
  const url = (
    process.env.CONTROL_PLANE_URL ??
    process.env.CP_URL ??
    ""
  ).replace(/\/$/, "");
  return url || null;
}

// Short cache — the catalog changes rarely and the pod edge enforces a strict
// rate limit, so we never fetch the CP per request.
const TTL_MS = 5 * 60_000;
let cache: { at: number; items: CPCapabilityTemplate[] } | null = null;

/**
 * Fetch the capability-template catalog from the CP (cached). Resilient: on any
 * failure returns the last good cache (or []), so a transient CP hiccup degrades
 * the catalog to "what we knew" rather than throwing.
 */
export async function fetchCPCapabilityTemplates(): Promise<
  CPCapabilityTemplate[]
> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.items;

  const base = cpUrl();
  if (!base) return cache?.items ?? [];

  try {
    const res = await fetch(`${base}/api/marketplace/capabilities`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return cache?.items ?? [];
    const data = (await res.json()) as {
      capabilities?: CPCapabilityTemplate[];
    };
    const items = Array.isArray(data.capabilities) ? data.capabilities : [];
    cache = { at: Date.now(), items };
    return items;
  } catch {
    return cache?.items ?? [];
  }
}

/** Resolve ONE capability definition by key from the CP catalog (or null). */
export async function fetchCPCapabilityTemplate(
  key: string
): Promise<CapabilityDefinition | null> {
  const items = await fetchCPCapabilityTemplates();
  return items.find((c) => c.key === key)?.definition ?? null;
}
