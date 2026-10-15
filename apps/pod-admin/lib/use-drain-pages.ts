"use client";

import { useEffect } from "react";

/** The slice of a react-query infinite query this hook drives. */
interface InfiniteLike {
  data?: { pages: readonly unknown[] };
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isError: boolean;
  fetchNextPage: () => unknown;
}

/**
 * Follow a cursor read to its end, up to `maxPages`.
 *
 * For lists whose filter COUNTS must be true over the whole set (Rules: "41
 * active · 2 failing"), a first page would make every count a lie about the
 * rest. Bounded so a pod with an absurd number of rows cannot spin the page:
 * past the cap `capped` is true and the page says its counts are partial.
 */
export function useDrainPages(query: InfiniteLike, maxPages: number) {
  const loaded = query.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError && loaded < maxPages) {
      void fetchNextPage();
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    isError,
    loaded,
    maxPages,
    fetchNextPage,
  ]);
  return {
    /** Still following the cursor. */
    draining: hasNextPage && loaded < maxPages && !isError,
    /** Stopped at the cap with more left. */
    capped: hasNextPage && loaded >= maxPages,
  };
}
