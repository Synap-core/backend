/**
 * Gmail → correspondents (the `google`/`email.thread` sync-kind handler).
 *
 * READ: `gmail_list_threads` (threads.list expanded with threads.get metadata).
 * First run: `newer_than:<windowDays>d`. Steady: `after:<epoch seconds of the
 * last completed run>` — Gmail's documented search operators, so only threads
 * with new mail come back. Mapping lives in `map-gmail-thread-to-graph.ts`.
 */

import { GOOGLE_PROVIDER } from "./map-gcal-to-graph.js";
import {
  mapGmailThreadToGraph,
  type GmailThreadItem,
} from "./map-gmail-thread-to-graph.js";
import { emptySyncGraph, mergeSyncGraph } from "./sync-graph.js";
import {
  registerSyncKind,
  readVerbPage,
  readCollection,
  readNextPageToken,
  type SyncFetchRequest,
  type SyncKindContext,
} from "./sync-kind-registry.js";

/** `gmail_list_threads` clampMax (nango-google template). */
const GMAIL_PAGE_MAX = 100;

export function gmailThreadQuery(
  req: Pick<SyncFetchRequest, "mode" | "since">,
  windowDays: number
): string {
  const sinceMs = req.since ? Date.parse(req.since) : Number.NaN;
  if (req.mode === "steady" && Number.isFinite(sinceMs)) {
    return `after:${Math.floor(sinceMs / 1000)}`;
  }
  return `newer_than:${windowDays}d`;
}

registerSyncKind({
  provider: GOOGLE_PROVIDER,
  kind: "email.thread",
  defaults: { enabled: true, windowDays: 90, itemLimit: 200, sources: [] },
  // Correspondents only — no thread entity, and Gmail documents no thread URL.
  profileSlugs: ["person", "company"],
  openableProfileSlugs: [],
  async fetchPage(ctx: SyncKindContext, req: SyncFetchRequest) {
    const result = await readVerbPage(ctx, "gmail_list_threads", {
      query: gmailThreadQuery(req, ctx.kindConfig.windowDays),
      maxResults: Math.max(1, Math.min(req.pageSize, GMAIL_PAGE_MAX)),
      ...(req.pageToken ? { pageToken: req.pageToken } : {}),
    });
    return {
      items: readCollection(result, "threads", "gmail_list_threads"),
      nextPageToken: readNextPageToken(result),
    };
  },
  mapItems(items) {
    const graph = emptySyncGraph();
    let skipped = 0;
    for (const item of items) {
      const mapped = mapGmailThreadToGraph(item as GmailThreadItem);
      if (!mapped || mapped.graph.entities.length === 0) skipped += 1;
      else mergeSyncGraph(graph, mapped.graph);
    }
    return { graph, skipped };
  },
});
