/**
 * Google Contacts → people (the `google`/`contact` sync-kind handler).
 *
 * READ: `contacts_list` (People connections, LAST_MODIFIED_DESCENDING). The
 * People API has no modified-since filter short of a sync token, so a steady run
 * re-reads the `itemLimit` most recently modified contacts; the runner's
 * external-link match makes that idempotent (merged, never duplicated).
 */

import { GOOGLE_PROVIDER } from "./map-gcal-to-graph.js";
import {
  mapGoogleContactToGraph,
  type GooglePerson,
} from "./map-google-contact-to-graph.js";
import { emptySyncGraph, mergeSyncGraph } from "./sync-graph.js";
import {
  registerSyncKind,
  readVerbPage,
  readCollection,
  readNextPageToken,
  type SyncFetchRequest,
  type SyncKindContext,
} from "./sync-kind-registry.js";

/** `contacts_list` clampMax (nango-google template). */
const CONTACTS_PAGE_MAX = 1000;

registerSyncKind({
  provider: GOOGLE_PROVIDER,
  kind: "contact",
  defaults: { enabled: true, windowDays: 90, itemLimit: 200, sources: [] },
  // People API documents no web URL for a contact.
  profileSlugs: ["person", "company"],
  openableProfileSlugs: [],
  async fetchPage(ctx: SyncKindContext, req: SyncFetchRequest) {
    const result = await readVerbPage(ctx, "contacts_list", {
      maxResults: Math.max(1, Math.min(req.pageSize, CONTACTS_PAGE_MAX)),
      ...(req.pageToken ? { pageToken: req.pageToken } : {}),
    });
    return {
      items: readCollection(result, "contacts", "contacts_list"),
      nextPageToken: readNextPageToken(result),
    };
  },
  mapItems(items) {
    const graph = emptySyncGraph();
    let skipped = 0;
    for (const item of items) {
      const mapped = mapGoogleContactToGraph(item as GooglePerson);
      if (!mapped) skipped += 1;
      else mergeSyncGraph(graph, mapped.graph);
    }
    return { graph, skipped };
  },
});
