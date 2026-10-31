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
import { formatDateTime } from "@synap-core/types/value-format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { useConsoleLocale, useT } from "../../../../lib/i18n/locale-provider";
import { trpc } from "../../../../lib/trpc";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { kindIcon } from "../../../_lib/object/kind-icon";
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

  const shown = showAll ? rows : rows.slice(0, FIRST_ROWS);
  return (
    <div>
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        {shown.map((row) => (
          <HistoryRowView key={row.id} row={row} onOpen={onOpen} />
        ))}
      </div>
      <div className="flex flex-col items-center gap-2 pt-3">
        {!showAll && rows.length > FIRST_ROWS && (
          <Button size="sm" variant="flat" onPress={() => setShowAll(true)}>
            {t("showAll", { n: rows.length })}
          </Button>
        )}
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

function HistoryRowView({
  row,
  onOpen,
}: {
  row: HistoryRow;
  onOpen?: (proposalId: string, title: string) => void;
}) {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const secondary = [
    row.kindLabel,
    row.askedBy ? t("row.askedBy", { who: row.askedBy }) : null,
    row.decidedBy?.kind === "person"
      ? t("row.decidedBy", { who: row.decidedBy.name })
      : row.decidedBy?.kind === "rule"
        ? t("row.decidedByRule")
        : null,
    row.space,
    formatDateTime(row.decidedAt, Date.now(), { locale }),
  ]
    .filter(Boolean)
    .join(" · ");

  const actions =
    row.undo === "available" ? (
      // Offered on an applied change only (`undoOf`): Undo takes it back.
      <UndoDecisionButton proposalId={row.id} verb="approve" />
    ) : row.undo === "permanent" ? (
      <span className="text-[12px] text-foreground/65">{t("row.noUndo")}</span>
    ) : null;

  const router = useRouter();
  return (
    <div data-row-id={row.id}>
      <ResourceRow
        Icon={kindIcon(row.targetType ?? "")}
        primary={row.title}
        secondary={secondary}
        status={{ kind: row.tone, label: row.statusLabel }}
        actions={actions}
        wrap
        onSelect={() =>
          onOpen ? onOpen(row.id, row.title) : router.push(row.href)
        }
      />
    </div>
  );
}
