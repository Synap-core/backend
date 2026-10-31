"use client";

/**
 * Every skill the reader can see, in every space (`skills.list`, `allSpaces`),
 * read page by page (the door returns at most 100 at a time, by offset) up to
 * `MAX_PAGES`. The Tools chips count over the whole set, so a first page alone
 * would make each count a lie about the rest; past the cap the page says the
 * list is partial (`capped`).
 */

import { useEffect, useState } from "react";
import { trpc } from "../../../../lib/trpc";

const PAGE = 100;
const MAX_PAGES = 5;
const READ = { staleTime: 30_000, retry: false } as const;

export function useAllSkills() {
  const [pages, setPages] = useState(1);
  const reads = trpc.useQueries((t) =>
    Array.from({ length: pages }, (_, i) =>
      t.skills.list({ allSpaces: true, limit: PAGE, offset: i * PAGE }, READ)
    )
  );
  const last = reads[reads.length - 1];
  const lastFull = last?.data?.skills.length === PAGE;
  useEffect(() => {
    if (lastFull && pages < MAX_PAGES) setPages((p) => p + 1);
  }, [lastFull, pages]);

  const failed = reads.find((r) => r.isError);
  const draining = lastFull && pages < MAX_PAGES;
  const isLoading = reads.some((r) => r.isLoading) || draining;
  return {
    /** null while loading or after a failed page: never a partial list. */
    skills:
      isLoading || failed ? null : reads.flatMap((r) => r.data?.skills ?? []),
    isLoading: isLoading && !failed,
    isError: Boolean(failed),
    error: failed?.error ?? null,
    /** Stopped at the cap with more left. */
    capped: lastFull && pages >= MAX_PAGES,
    shown: PAGE * MAX_PAGES,
    refetch: () => {
      for (const r of reads) if (r.isError) void r.refetch();
    },
  };
}
