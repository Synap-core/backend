/**
 * Sites — where each site stands, decided ONCE (design 73df57f3, variant A).
 *
 * Every mark the Sites pages draw comes from here: a list row's chip, the site
 * page's header pill, its one primary action, and each record's and chart's
 * pill. The server already decided the hard parts (`shares.listSites`,
 * `shares.siteStatus`: `live` is `isSiteLive`, the one rule; a member's and a
 * chart's `live` is the public doors' own predicate), so this file only maps
 * those facts onto marks and words. It never re-derives liveness.
 *
 * Every row of the list carries a chip, Live included (founder's amendment:
 * "showcasing site status, like need you, error, etc., on the list").
 */

import { resolveObjectNounPlural } from "@synap-core/types/vocabulary";
import type { StatusKind } from "../../components/status-pill";

/** The facts a site's mark needs: a `listSites` row, or a `siteStatus`. */
export interface SiteFacts {
  state: string;
  live: boolean;
  hasToken: boolean;
  /** null = the caller cannot read the switch (owner only): "can't check", never "on". */
  publicDoorsOpen: boolean | null;
  /** null = the caller cannot read the policy (owner only). */
  policyAllowsSites: boolean | null;
  /** Published records changed since their snapshot (the list row has it). */
  staleCount?: number;
}

export type SiteMarkKey =
  | "error"
  | "revoked"
  | "policy-blocks"
  | "doors-off"
  | "not-live"
  | "off-web"
  | "changed"
  | "live";

export interface SiteMark {
  key: SiteMarkKey;
  kind: StatusKind;
  label: string;
  /** Something only the person can do waits on this site. */
  needsYou: boolean;
}

const MARKS: Record<Exclude<SiteMarkKey, "changed">, SiteMark> = {
  error: { key: "error", kind: "down", label: "Error", needsYou: false },
  revoked: { key: "revoked", kind: "down", label: "Revoked", needsYou: false },
  "policy-blocks": {
    key: "policy-blocks",
    kind: "down",
    label: "Sites not allowed",
    needsYou: true,
  },
  "doors-off": {
    key: "doors-off",
    kind: "down",
    label: "Public pages off",
    needsYou: true,
  },
  "not-live": {
    key: "not-live",
    kind: "unknown",
    label: "Not live yet",
    needsYou: true,
  },
  "off-web": {
    key: "off-web",
    kind: "unknown",
    label: "Off the web",
    needsYou: false,
  },
  live: { key: "live", kind: "healthy", label: "Live", needsYou: false },
};

export function recordsWord(n: number): string {
  return n === 1 ? "1 record" : `${n} records`;
}

export function chartsWord(n: number): string {
  return n === 1 ? "1 chart" : `${n} charts`;
}

/** The read failed: a mark with a retry beside it, never a calm state. */
export const ERROR_MARK: SiteMark = MARKS.error;
/** Revoked: known only right after the act (a revoked site leaves the reads). */
export const REVOKED_MARK: SiteMark = MARKS.revoked;

/**
 * THE site mark. What needs the person outranks how the site is doing:
 *   1. not live, and the home space's policy does not allow a site → it
 *      cannot go live until the owner changes the policy;
 *   2. live, but the home space's public pages are off → visitors are refused;
 *   3. never put live (no link yet) → Not live yet;
 *   4. taken off the web (link kept) → Off the web;
 *   5. live with records changed since published → "N records changed";
 *   6. live → Live.
 * An unreadable switch or policy (null) never raises a mark: the page says
 * "can't check" beside it instead.
 */
export function siteMark(site: SiteFacts): SiteMark {
  if (!site.live && site.policyAllowsSites === false) {
    return MARKS["policy-blocks"];
  }
  if (site.live && site.publicDoorsOpen === false) return MARKS["doors-off"];
  if (!site.live) return site.hasToken ? MARKS["off-web"] : MARKS["not-live"];
  const stale = site.staleCount ?? 0;
  if (stale > 0) {
    return {
      key: "changed",
      kind: "stale",
      label: stale === 1 ? "1 record changed" : `${stale} records changed`,
      needsYou: true,
    };
  }
  return MARKS.live;
}

/** The site page's one primary action, or none (never a disabled one). */
export type SitePrimaryAction = "put-live" | "put-back-live" | null;

export function sitePrimaryAction(site: SiteFacts): SitePrimaryAction {
  if (site.live) return null;
  // Going live would be refused: the banner says why, no dead button.
  if (site.policyAllowsSites === false) return null;
  return site.hasToken ? "put-back-live" : "put-live";
}

export const PRIMARY_ACTION_LABEL: Record<
  Exclude<SitePrimaryAction, null>,
  string
> = {
  "put-live": "Put live",
  "put-back-live": "Put back live",
};

/** The list row's second line: what the site holds, then what is wrong. */
export function siteRowFacts(
  site: SiteFacts & { recordsTotal: number; chartsTotal: number }
): string[] {
  const mark = siteMark(site);
  const holds = [recordsWord(site.recordsTotal)];
  if (site.chartsTotal > 0) holds.push(chartsWord(site.chartsTotal));
  switch (mark.key) {
    case "not-live":
      return ["Set up", ...holds];
    case "doors-off":
      return [...holds, "visitors are refused"];
    case "policy-blocks":
      return [...holds, "its space's sharing rules don't allow a site"];
    default:
      return holds;
  }
}

/**
 * Needs-you first, then the rest, each group in the server's order (newest
 * site first). Stable, pure.
 */
export function orderSites<T extends SiteFacts>(sites: readonly T[]): T[] {
  const needs = sites.filter((s) => siteMark(s).needsYou);
  const rest = sites.filter((s) => !siteMark(s).needsYou);
  return [...needs, ...rest];
}

// ── Records and charts of one site ──────────────────────────────────────────

export interface ItemMark {
  kind: StatusKind;
  label: string;
}

/**
 * A record's pill on the site page. Live, or anything while the site itself
 * is not live (the header says that), has no pill.
 */
export function memberMark(
  member: { state: string; live: boolean; stale: boolean },
  siteLive: boolean
): ItemMark | null {
  if (member.state === "draft") return { kind: "unknown", label: "Taken off" };
  if (member.stale) return { kind: "stale", label: "Changed since published" };
  if (siteLive && !member.live) return { kind: "stale", label: "Not shown" };
  return null;
}

/** A chart's pill: the same grammar, no "changed" (a snapshot is refreshed by hand). */
export function chartMark(
  chart: { state: string; live: boolean },
  siteLive: boolean
): ItemMark | null {
  if (chart.state === "draft") return { kind: "unknown", label: "Taken off" };
  if (siteLive && !chart.live) return { kind: "stale", label: "Not shown" };
  return null;
}

/** A chart's mode, in words. Unknown when its stored payload no longer reads. */
export function chartModeLabel(mode: string | null): string {
  if (mode === "snapshot") return "Snapshot";
  if (mode === "live") return "Live data";
  return "Unreadable";
}

/**
 * A collection key in words: the profile's plural noun. Never the raw key,
 * and never `@charts` (charts are their own tab).
 */
export function collectionLabel(key: string | null): string | null {
  if (!key || key.startsWith("@")) return null;
  return resolveObjectNounPlural(key);
}

// ── The link ────────────────────────────────────────────────────────────────

/** The site's data address: what a site kit or a visitor's page reads. */
export function siteDataAddress(podUrl: string, token: string): string {
  return `${podUrl.replace(/\/+$/, "")}/api/hub/public/sites/${token}`;
}

/** After the reveal only the token's start is readable. */
export function linkPrefixLabel(tokenPrefix: string | null): string | null {
  return tokenPrefix ? `…/sites/${tokenPrefix}…` : null;
}

// ── Lists on the site page ──────────────────────────────────────────────────

/** How many records and charts the site page shows before "Show all". */
export const SITE_PAGE_ITEMS = 20;

/** The tab label with its count ("Records 24"). */
export function tabLabel(word: string, total: number): string {
  return `${word} ${total}`;
}
