/**
 * THE host table of the pod's built-in reader: every site adapter, the URLs
 * it declares, and the hosts the pod never fetches itself. It replaces the
 * old `oembedEndpoint` switch (read-public-url.ts asks {@link oembedEndpointFor}).
 *
 * Routing is by declared pattern (`@synap-core/types/url-read` grammar), most
 * specific first — the same rule installed reader verbs are routed by.
 */

import {
  matchUrlPattern,
  urlPatternSpecificity,
} from "@synap-core/types/url-read";
import type { SiteAdapter } from "./adapter.js";
import { arxivAdapter } from "./adapters/arxiv.js";
import { blueskyAdapter } from "./adapters/bluesky.js";
import { githubAdapter } from "./adapters/github.js";
import { googleDocsAdapter } from "./adapters/google-docs.js";
import { hackerNewsAdapter } from "./adapters/hacker-news.js";
import {
  tiktokAdapter,
  vimeoAdapter,
  youtubeAdapter,
} from "./adapters/oembed.js";
import { redditAdapter } from "./adapters/reddit.js";
import { wikipediaAdapter } from "./adapters/wikipedia.js";
import { xAdapter } from "./adapters/x.js";

/** Every built-in site adapter. A new site joins routing by being listed here. */
export const SITE_ADAPTERS: readonly SiteAdapter[] = [
  youtubeAdapter,
  tiktokAdapter,
  vimeoAdapter,
  xAdapter,
  blueskyAdapter,
  hackerNewsAdapter,
  githubAdapter,
  wikipediaAdapter,
  arxivAdapter,
  redditAdapter,
  googleDocsAdapter,
];

/**
 * Hosts whose PAGES the pod never fetches (decision P1): Instagram and
 * TikTok. A reader the person installed may read them, on their account,
 * after their tap — never the pod's own fetch. (TikTok's official oEmbed
 * endpoint is not a page fetch; the TikTok adapter uses it.)
 */
export const POD_NEVER_FETCHES: readonly string[] = [
  "*.instagram.com",
  "instagr.am",
  "*.tiktok.com",
];

export function podNeverFetches(url: string): boolean {
  return POD_NEVER_FETCHES.some((p) => matchUrlPattern(p, url));
}

/** Specificity of the adapter's best pattern for `url`, or -1. */
function bestMatch(adapter: SiteAdapter, url: string): number {
  let best = -1;
  for (const p of adapter.urls) {
    if (matchUrlPattern(p, url))
      best = Math.max(best, urlPatternSpecificity(p));
  }
  return best;
}

/** The most specific adapter that declares `url`, or null. */
export function findSiteAdapter(
  url: string,
  adapters: readonly SiteAdapter[] = SITE_ADAPTERS
): SiteAdapter | null {
  let found: SiteAdapter | null = null;
  let score = -1;
  for (const a of adapters) {
    const s = bestMatch(a, url);
    if (s > score) {
      found = a;
      score = s;
    }
  }
  return found;
}

/**
 * The official oEmbed endpoint for `pageUrl` (no API key), from the adapter
 * that declares the URL — or null when no oEmbed site declares it.
 */
export function oembedEndpointFor(pageUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null; // not a URL: no endpoint
  }
  const withOembed = SITE_ADAPTERS.filter((a) => a.oembed);
  const adapter = findSiteAdapter(pageUrl, withOembed);
  return adapter?.oembed ? adapter.oembed(url) : null;
}
