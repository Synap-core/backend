"use client";

/**
 * Historique's list: the requests already decided that this viewer may see
 * (`proposals.list`, the viewer's own floor), newest first. Grown from
 * Review › History (audit 110dd4ab G2), which now draws this same list.
 *
 * Bounded (ui-composition §4): the first rows, then "Show all" for what the
 * read holds, then older decisions page by page (the pod's cursor). Loading,
 * empty and failed are three states; a failed read keeps its Retry.
 *
 * Every row is a door: on `/history` to the decision's own page and its
 * receipt; inside Review (`onOpen`) to Review's drawer.
 */

import { Button } from "@heroui/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "@synap-core/types/i18n";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { useT } from "../../../../lib/i18n/locale-provider";
import { trpc } from "../../../../lib/trpc";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { TimelineList } from "../../../_lib/timeline/timeline-list";
import { en, fr } from "./copy";
import { historyRows, type HistoryRow } from "./history-rows";
import { UndoDecisionButton } from "../../../_lib/receipt/decision-receipt-toast";

const CATALOGS = { en, fr };
/** Rows shown before "Show all". */
const FIRST_ROWS = 10;
/** One read of the pod; pending requests in it are left out. */
const PAGE_SIZE = 50;

export function HistoryList({
  sessionId,
  onOpen,
}: {
  /** Narrowed to one session (Review's `?session=`): its decisions only. */
  sessionId?: string | null;
  /** Inside Review: open the decision in Review's drawer instead of its page. */
  onOpen?: (proposalId: string, title: string) => void;
}) {
  const t = useT(CATALOGS);
  const list = trpc.proposals.list.useInfiniteQuery(
    { status: "all", limit: PAGE_SIZE, ...(sessionId ? { sessionId } : {}) },
    {
      getNextPageParam: (last) => last.pagination.nextCursor ?? undefined,
      staleTime: 30_000,
    }
  );
  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(
    () => historyRows((list.data?.pages ?? []).flatMap((p) => p.items)),
    [list.data]
  );
  const entries = useMemo(() => rows.map((r) => r.entry), [rows]);

  if (list.isLoading) return <ResourceRowSkeleton count={4} />;
  // A failed FIRST read: nothing to show, so the failure is the state.
  if (list.isError && rows.length === 0)
    return (
      <ResourceRowError
        message={t("failed")}
        onRetry={() => void list.refetch()}
      />
    );
  if (rows.length === 0 && !list.hasNextPage)
    return <ResourceRowEmpty message={t("empty")} />;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const router = useRouter();
  const open = (id: string) => {
    const row = byId.get(id);
    if (!row) return;
    if (onOpen) onOpen(row.id, row.title);
    else router.push(row.href);
  };
  return (
    <div>
      <div className="-mx-2">
        <TimelineList
          entries={entries}
          cap={FIRST_ROWS}
          expanded={showAll}
          onExpand={() => setShowAll(true)}
          showAllLabel={t("showAll", { n: rows.length })}
          onSelect={(e) => open(e.key)}
          detail={(e) => detailOf(byId.get(e.key), t)}
          actions={(e) => actionsOf(byId.get(e.key), t)}
        />
      </div>
      <div className="flex flex-col items-center gap-2 pt-3">
        {(showAll || rows.length <= FIRST_ROWS) &&
          list.hasNextPage &&
          (list.isFetchNextPageError ? (
            <ResourceRowError
              message={t("olderFailed")}
              onRetry={() => void list.fetchNextPage()}
            />
          ) : (
            <Button
              size="sm"
              variant="light"
              isLoading={list.isFetchingNextPage}
              onPress={() => {
                setShowAll(true);
                void list.fetchNextPage();
              }}
            >
              {t("showOlder")}
            </Button>
          ))}
      </div>
    </div>
  );
}

/** What the page adds to the row's own line: kind, who asked, who decided, space. */
function detailOf(
  row: HistoryRow | undefined,
  t: TFunction<typeof en>
): string | null {
  if (!row) return null;
  return (
    [
      row.kindLabel,
      row.askedBy ? t("row.askedBy", { who: row.askedBy }) : null,
      row.who?.text ?? null,
      row.space,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
}

function actionsOf(row: HistoryRow | undefined, t: TFunction<typeof en>) {
  if (!row) return null;
  // Offered on an applied change only (`undoOf`): Undo takes it back.
  if (row.undo === "available")
    return <UndoDecisionButton proposalId={row.id} verb="approve" />;
  if (row.undo === "permanent")
    return (
      <span className="text-[12px] text-foreground/65">{t("row.noUndo")}</span>
    );
  return null;
}
