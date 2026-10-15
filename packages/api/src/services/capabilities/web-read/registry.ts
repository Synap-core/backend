/**
 * THE host table of the pod's built-in reader: every site adapter and the
 * URLs it declares. The hosts the pod never fetches itself are policy, stated
 * once in `@synap-core/types/url-read` (`POD_NEVER_FETCHES`).
 *
 * Routing is by declared pattern (`@synap-core/types/url-read` grammar), most
 * specific first — the same rule installed reader verbs are routed by.
 */

import { bestUrlPatternSpecificity } from "@synap-core/types/url-read";
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
// The fetch policy (decision P1) lives in the url-read leaf, stated once.
export { POD_NEVER_FETCHES, podNeverFetches } from "@synap-core/types/url-read";

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

/** The most specific adapter that declares `url`, or null. */
export function findSiteAdapter(
  url: string,
  adapters: readonly SiteAdapter[] = SITE_ADAPTERS
): SiteAdapter | null {
  let found: SiteAdapter | null = null;
  let score = -1;
  for (const a of adapters) {
    const s = bestUrlPatternSpecificity(a.urls, url);
    if (s > score) {
      found = a;
      score = s;
    }
  }
  return found;
}
