/**
 * Template corpus adapter — bundle → `TemplateFingerprint[]`.
 *
 * The candidate universe is the FROZEN `@synap-core/workspace-templates`
 * bundle, deliberately, not the `cp_catalog_cache`. The cache's list route
 * omits `definition` ("can be large"), so a template's PROFILES — the primary
 * evidence — are only reliably readable locally. A CP-only template is
 * therefore invisible to the matcher and its workspaces come back UNKNOWN,
 * which is the safe direction: no stamp rather than a wrong one.
 *
 * A stamp derived from this corpus still round-trips correctly at reconcile
 * time, because `resolveWorkspaceTemplate` is cache-FIRST and keyed by the
 * same `meta.slug` this module reports — a slug identified from the bundle
 * resolves to the FRESHEST CP body on the next boot.
 */

import { listWorkspaceTemplates } from "@synap-core/workspace-templates";
import { normalizeName, type TemplateFingerprint } from "./fingerprint.js";

export function bundledTemplateFingerprints(): TemplateFingerprint[] {
  return listWorkspaceTemplates().map((t) => ({
    slug: t.meta.slug,
    subtype: t.workspace?.subtype,
    names: [t.meta.name, t.workspace?.name]
      .filter((n): n is string => typeof n === "string" && n.length > 0)
      .map(normalizeName),
    profileSlugs: (t.profiles ?? []).map((p) => p.slug),
    sourceRoles: t.workspace?.sourceRoles as Record<string, string> | undefined,
  }));
}
