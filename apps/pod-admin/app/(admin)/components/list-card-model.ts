/**
 * The rules of a list card, pure so they run in a test: which of the four
 * states it draws, and the window of an offset-paged list. A failed read is
 * never an empty list (an error draws its own state, with the retry), and a
 * list that already has rows keeps them while a refetch is in flight.
 */

export type ListCardState = "loading" | "error" | "empty" | "rows";

export function listCardState(input: {
  /** First load (no rows yet), or a redirect to sign-in in flight. */
  loading: boolean;
  isError: boolean;
  rowCount: number;
}): ListCardState {
  if (input.loading && input.rowCount === 0) return "loading";
  if (input.isError) return "error";
  if (input.rowCount === 0) return "empty";
  return "rows";
}

export interface PageWindow {
  page: number;
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevOffset: number;
  nextOffset: number;
}

/** The pager of a server-paginated list (`limit` / `offset` / `total`). */
export function pageWindow(
  offset: number,
  limit: number,
  total: number
): PageWindow {
  const pageCount = Math.max(1, Math.ceil(total / limit));
  return {
    page: Math.floor(offset / limit) + 1,
    pageCount,
    hasPrev: offset > 0,
    hasNext: offset + limit < total,
    prevOffset: Math.max(0, offset - limit),
    nextOffset: offset + limit,
  };
}
