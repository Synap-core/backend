/**
 * Catalog reader offers (pure): the `cp_catalog_cache` capability packs the
 * person has NOT installed whose reader skills declare a URL pattern that
 * matches — "Install X to read this". Part of the one reader door.
 */

import {
  bestUrlPatternSpecificity,
  type UrlReaderOffer,
} from "@synap-core/types/url-read";
import { isHttpUrl } from "@synap-core/types/navigation";
import type { CatalogCacheEntry } from "./catalog-cache-query.js";
import { capabilityNextAction } from "./capability-enable-link.js";
import { projectUrlPatterns } from "./capability-drift.js";
import {
  compareReaders,
  serviceIdFor,
  type RankedReader,
} from "./url-reader-fold.js";

interface CatalogReaderSkill {
  name: string;
  urls: string[];
  requires?: string[];
}

export function catalogReaderSkills(
  definition: Record<string, unknown> | null
): { skills: CatalogReaderSkill[]; credentialedTools: Set<string> } | null {
  if (!definition) return null;
  const skills = definition.skills;
  if (!Array.isArray(skills)) return null;
  const credentialedTools = new Set<string>();
  for (const t of Array.isArray(definition.tools) ? definition.tools : []) {
    const tool = t as { name?: unknown; credentialRef?: unknown };
    if (
      typeof tool.name === "string" &&
      typeof tool.credentialRef === "string" &&
      tool.credentialRef.trim()
    ) {
      credentialedTools.add(tool.name);
    }
  }
  const out: CatalogReaderSkill[] = [];
  for (const s of skills) {
    const skill = s as {
      name?: unknown;
      urls?: unknown;
      intent?: unknown;
      metadata?: unknown;
      requires?: unknown;
    };
    if (typeof skill.name !== "string") continue;
    // The applier's own projection (the gate included): these are OFFICIAL
    // catalog entries (`cp_catalog_cache` read unscoped = the official source).
    const urls = projectUrlPatterns(
      skill as Parameters<typeof projectUrlPatterns>[0],
      { officialSource: true }
    );
    if (!urls) continue;
    out.push({
      name: skill.name,
      urls,
      ...(Array.isArray(skill.requires)
        ? {
            requires: skill.requires.filter(
              (r): r is string => typeof r === "string"
            ),
          }
        : {}),
    });
  }
  return { skills: out, credentialedTools };
}

export function rankedInstallOffers(
  entries: readonly CatalogCacheEntry[],
  url: string,
  installedSlugs: ReadonlySet<string>
): RankedReader[] {
  if (!isHttpUrl(url.trim())) return [];
  const out = new Map<string, RankedReader>();
  for (const entry of entries) {
    if (entry.kind !== "capability") continue;
    const key =
      typeof entry.definition?.key === "string" ? entry.definition.key : null;
    if (installedSlugs.has(entry.slug) || (key && installedSlugs.has(key)))
      continue;
    // An entry whose definition the cache does not carry declares nothing we
    // can read; it is simply not offered (a best-effort invite, not a verdict).
    const parsed = catalogReaderSkills(entry.definition);
    if (!parsed) continue;
    for (const skill of parsed.skills) {
      const spec = bestUrlPatternSpecificity(skill.urls, url);
      if (spec < 0 || out.has(skill.name)) continue;
      const serviceId = serviceIdFor(entry.slug, entry.name);
      const billed = (skill.requires ?? []).some((t) =>
        parsed.credentialedTools.has(t)
      );
      out.set(skill.name, {
        offer: {
          readerId: skill.name,
          name: entry.name,
          ...(serviceId ? { serviceId } : {}),
          installSlug: entry.slug,
          billing: billed ? "account" : "none",
          state: "install",
          hint: capabilityNextAction("available", entry.name).hint,
        },
        specificity: spec,
        builtin: false,
      });
    }
  }
  return [...out.values()].sort(compareReaders);
}

/**
 * PURE: catalog readers of `url` the person has not installed — the
 * `cp_catalog_cache` capability definitions whose `skills[].urls` match.
 * `installedSlugs` holds the template keys / slugs already on the pod (an
 * installed pack's reader is an `enable`/`ready` offer, never an install).
 */
export function installOffersForUrl(
  catalogEntries: readonly CatalogCacheEntry[],
  url: string,
  installedSlugs: ReadonlySet<string>
): UrlReaderOffer[] {
  return rankedInstallOffers(catalogEntries, url, installedSlugs).map(
    (r) => r.offer
  );
}
