"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * The href `edit` makes of the current query. A cleared query leaves the bare
 * pathname — no dangling `?`.
 */
export function editedHref(
  pathname: string,
  current: string,
  edit: (params: URLSearchParams) => void
): string {
  const params = new URLSearchParams(current);
  edit(params);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * Rewrite the current URL's query in place: the edit sees a copy of the live
 * params, the history entry is replaced (a filter or tab is a view of the
 * page, not a place to go back to) and the scroll position stays put. Must sit
 * under a Suspense boundary (`useSearchParams`).
 */
export function useReplaceParams(): (
  edit: (params: URLSearchParams) => void
) => void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (edit) =>
      router.replace(editedHref(pathname, searchParams.toString(), edit), {
        scroll: false,
      }),
    [router, pathname, searchParams]
  );
}
