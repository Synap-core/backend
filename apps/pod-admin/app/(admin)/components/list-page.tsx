"use client";

/**
 * The one shape of a pod admin list page (founder, 2026-11-07; decision
 * afab5911): (1) `PageHeader`, a title and one line, (2) `ListToolbar`, ONE
 * row holding search, one `FilterChip` per filter, then tabs and the primary,
 * (3) `ListCard`, the card that lists the rows with its loading, error
 * (retry) and empty states and its pager. A page composes these three and
 * brings only its rows and its filters' options (`filter-options.ts` gives a
 * status or a kind its glyph and colour).
 */

import { Button } from "@heroui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { FilterRow } from "./filter-chip";
import { listCardState, pageWindow } from "./list-card-model";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "./resource-row";
import { SectionCard } from "./section-card";

export { PageHeader } from "./page-header";
export { FilterChip } from "./filter-chip";
/** The toolbar row: search, filter chips, tabs, primary. Never a second row. */
export const ListToolbar = FilterRow;

export type ListPagination =
  | {
      kind: "offset";
      offset: number;
      limit: number;
      total: number;
      onOffsetChange: (offset: number) => void;
    }
  | {
      kind: "more";
      hasNext: boolean;
      isFetchingNext: boolean;
      onLoadMore: () => void;
    };

export function ListCard({
  title,
  hint,
  count,
  actions,
  loading,
  isError,
  onRetry,
  errorMessage,
  rowCount,
  emptyMessage,
  skeletonRows = 5,
  pagination,
  above,
  footer,
  children,
}: {
  title: string;
  hint?: ReactNode;
  count?: number | null;
  actions?: ReactNode;
  loading: boolean;
  isError: boolean;
  /** Offered with the error: a failed read keeps its way back. */
  onRetry?: () => void;
  errorMessage: string;
  rowCount: number;
  emptyMessage: ReactNode;
  skeletonRows?: number;
  pagination?: ListPagination;
  /** Above the rows, in every state: a pinned row, a notice. */
  above?: ReactNode;
  /** Below the rows: a partial-read note, a secondary error. */
  footer?: ReactNode;
  /** The rows, drawn only when there are some. */
  children: ReactNode;
}) {
  const state = listCardState({ loading, isError, rowCount });
  const window =
    pagination?.kind === "offset"
      ? pageWindow(pagination.offset, pagination.limit, pagination.total)
      : null;
  const pager =
    pagination?.kind === "offset" && window && window.pageCount > 1 ? (
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] text-foreground/65">
          Page {window.page} / {window.pageCount}
        </span>
        <Button
          isIconOnly
          variant="light"
          size="sm"
          radius="full"
          isDisabled={!window.hasPrev}
          onPress={() => pagination.onOffsetChange(window.prevOffset)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          isIconOnly
          variant="light"
          size="sm"
          radius="full"
          isDisabled={!window.hasNext}
          onPress={() => pagination.onOffsetChange(window.nextOffset)}
          aria-label="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    ) : null;

  return (
    <SectionCard
      title={title}
      hint={hint}
      count={count}
      actions={
        pager || actions ? (
          <div className="flex items-center gap-3">
            {actions}
            {pager}
          </div>
        ) : undefined
      }
    >
      {above}
      {state === "loading" ? (
        <ResourceRowSkeleton count={skeletonRows} />
      ) : state === "error" ? (
        <ResourceRowError message={errorMessage} onRetry={onRetry} />
      ) : state === "empty" ? (
        <ResourceRowEmpty message={emptyMessage} />
      ) : (
        children
      )}
      {footer}
      {pagination?.kind === "more" &&
        pagination.hasNext &&
        (state === "rows" || state === "empty") && (
          <div className="px-1 pt-3">
            <Button
              size="sm"
              variant="light"
              radius="md"
              isLoading={pagination.isFetchingNext}
              onPress={pagination.onLoadMore}
            >
              Load more
            </Button>
          </div>
        )}
    </SectionCard>
  );
}
