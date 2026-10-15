/**
 * Find Library items by the words of what was READ from them.
 *
 * The light read stores an item's text in storage (`importRead.textKey`), never
 * in the row, so the SQL match of `searchLibrary` (title, card, URL, summary,
 * note) cannot see it. The search index can: a read's completion queues a
 * `search-index` upsert (`light-read.ts` → `enqueueLibrarySearch`), and the
 * documents indexer folds the read text into `content`
 * (`documentTextStorageKey` → `loadDocumentBodyTexts`, ≤ 64k chars). This asks
 * that index for the ids of the caller's Library items whose title or read text
 * match, and nothing else: the ids are CANDIDATES — `searchLibrary` floors every
 * one of them with `libraryItemsWhere(userId)`, so an index row is never a grant.
 *
 * A failed lookup THROWS. Callers decide what an index outage means; folding it
 * into "no ids" would make a kept page unfindable by its own words and say so
 * as "found nothing".
 */

/** Ids asked of the index at most (a candidate pool, not the answer's size). */
export const LIBRARY_READ_TEXT_POOL = 50;

export type LibraryReadTextLookup = (args: {
  userId: string;
  q: string;
  limit: number;
}) => Promise<string[]>;

export const findLibraryReadTextIds: LibraryReadTextLookup = async (args) => {
  const { searchService } = await import("@synap/search");
  const res = await searchService.searchCollection("documents", args.q, {
    userId: args.userId,
    limit: Math.min(Math.max(args.limit, 1), LIBRARY_READ_TEXT_POOL),
    libraryOnly: true,
  });
  return res.results.map((r) => r.id);
};
