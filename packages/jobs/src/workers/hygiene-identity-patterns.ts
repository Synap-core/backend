/**
 * H0 — pure identity / data-quality pattern detectors (propose-only pipeline).
 *
 * Reused by pod-hygiene jobs and future "AI adjunct" playbooks. Never merges.
 * Detection only → callers file proposals.
 *
 * Patterns:
 *   1. Sentinel titles ("Not publicly disclosed", …) — Excel/import junk names
 *   2. Property-key aliases (linkedin_url vs linkedinurl) — schema fold candidates
 *
 * Junk/sentinel titles: SSOT is `@synap/database` `isJunkEntityTitle` /
 * `JUNK_ENTITY_TITLES` (entity-create-guardrails). Do not re-list placeholders here.
 */

import { isJunkEntityTitle } from "@synap/database";

/** Profiles where placeholder titles are never acceptable (align create gate). */
export const IDENTITY_SCAN_KINDS = ["person", "company", "contact"] as const;

/**
 * Canonical property keys → accepted aliases (lowercased, non-alphanum stripped).
 * Used to detect orphan keys that should fold into an existing field.
 *
 * Note: ultra-generic website aliases `url` / `site` are intentionally omitted —
 * a bare `url` is often an article link, not the org homepage identity field.
 */
export const PROPERTY_KEY_ALIASES: Record<string, readonly string[]> = {
  linkedinurl: [
    "linkedin_url",
    "linkedin-url",
    "linkedin url",
    "linkedinurl",
    "li_url",
    "linkedin",
  ],
  website: ["web_site", "web-site", "homepage", "home_page"],
  email: ["e_mail", "e-mail", "mail", "email_address", "emailaddress"],
  phone: ["telephone", "tel", "mobile", "phone_number", "phonenumber"],
  twitterhandle: [
    "twitter",
    "twitter_handle",
    "x_handle",
    "xhandle",
    "twitter_url",
  ],
};

export function normalizeTitle(title: string | null | undefined): string {
  return (title ?? "").trim().toLowerCase();
}

/**
 * True when title is empty or a known placeholder invent by agents/import.
 * Thin alias of create-gate `isJunkEntityTitle` (shared junk list).
 */
export function isSentinelTitle(title: string | null | undefined): boolean {
  return isJunkEntityTitle(title);
}

/** Collapse key for alias comparison: lower + strip non-alphanumeric. */
export function normalizePropertyKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export interface PropertyAliasHit {
  /** Key present on the entity that is an alias of a canonical field. */
  orphanKey: string;
  /** Canonical key it should fold into. */
  canonicalKey: string;
  /** Value currently on the orphan key (if any). */
  value: unknown;
  /** Whether the canonical key already has a non-empty value. */
  canonicalOccupied: boolean;
}

/**
 * Find property keys that should fold into a preferred canonical spelling.
 * Does not mutate — callers propose a data-only fold.
 *
 * Hits when:
 *  - key normalizes to a known field (e.g. "LinkedIn URL" → linkedinurl) but
 *    spelling ≠ preferred canonical ("linkedinurl"), OR
 *  - key matches an alias list entry that differs from the preferred key.
 */
export function findPropertyKeyAliasHits(
  properties: Record<string, unknown> | null | undefined
): PropertyAliasHit[] {
  if (!properties || typeof properties !== "object") return [];
  const hits: PropertyAliasHit[] = [];
  const seen = new Set<string>();

  for (const [canonical, aliases] of Object.entries(PROPERTY_KEY_ALIASES)) {
    const canNorm = normalizePropertyKey(canonical);
    const preferredSpelling = canonical;
    // Key that already uses preferred spelling (exact match only)
    const preferredActual = Object.keys(properties).find(
      (k) => k === preferredSpelling
    );
    const preferredVal = preferredActual
      ? properties[preferredActual]
      : undefined;
    const preferredOccupied =
      preferredVal !== undefined &&
      preferredVal !== null &&
      preferredVal !== "";

    for (const actual of Object.keys(properties)) {
      const aNorm = normalizePropertyKey(actual);
      const isAliasListHit = aliases.some(
        (a) => normalizePropertyKey(a) === aNorm
      );
      const isNormMatchOfCanonical = aNorm === canNorm;
      if (!isAliasListHit && !isNormMatchOfCanonical) continue;
      // Already preferred spelling — nothing to fold
      if (actual === preferredSpelling) continue;
      const dedupe = `${actual}->${preferredSpelling}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      hits.push({
        orphanKey: actual,
        canonicalKey: preferredSpelling,
        value: properties[actual],
        canonicalOccupied: preferredOccupied,
      });
    }
  }
  return hits;
}

export interface SentinelEntityHit {
  id: string;
  title: string | null;
  type: string;
  /** Non-empty property keys that suggest the row is otherwise real. */
  richPropertyKeys: string[];
  propertyAliasHits: PropertyAliasHit[];
}

/**
 * Classify one entity for H0 sentinel + alias patterns.
 * `rich` = has other useful props (so retitle/merge is worthwhile, not empty junk).
 */
export function classifyIdentityHygieneEntity(input: {
  id: string;
  title: string | null;
  type: string;
  properties?: Record<string, unknown> | null;
}): {
  isSentinel: boolean;
  isRich: boolean;
  propertyAliasHits: PropertyAliasHit[];
  hit: SentinelEntityHit | null;
} {
  const props = input.properties ?? {};
  const isSentinel = isSentinelTitle(input.title);
  const propertyAliasHits = findPropertyKeyAliasHits(props);
  const richPropertyKeys = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
    .map(([k]) => k);
  const isRich = richPropertyKeys.length >= 1;
  if (!isSentinel && propertyAliasHits.length === 0) {
    return { isSentinel, isRich, propertyAliasHits, hit: null };
  }
  return {
    isSentinel,
    isRich,
    propertyAliasHits,
    hit: {
      id: input.id,
      title: input.title,
      type: input.type,
      richPropertyKeys,
      propertyAliasHits,
    },
  };
}
