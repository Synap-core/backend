"use client";

/**
 * Why an approval FAILED, and the fix, on the pod-admin review (decision
 * fa6c8833). The page used to show a failed proposal with its Approve and
 * Reject buttons and no word of what went wrong: the founder rejected three
 * of five preferences that failed on one wrong value (`preference` for
 * `preferences`), and two agents filed the same five again.
 *
 * It draws the pod's own answers and nothing else: the classified sentence
 * (`rejectionReason`), then `proposals.repairOptions` as rows
 * (`repair-card-model.ts`). A press sends `proposals.repair` (it revises
 * the proposal, and may add the value to its field), then `proposals.approve`
 * with exactly the revision the repair made, so every approval gate runs and
 * a revise landing in between is refused. A failed read says so with a
 * retry; it never reads as "nothing to fix".
 *
 * A GRAPH that stopped part-way (`stopped-graph-model.ts`) says what it
 * filed: "4 of 11 items filed · 1 could not be filed · 6 not tried", the
 * filed records as links, the item that failed with its reason (a missing
 * kind names the space and where the kind exists), and what was never tried.
 * The item it waits on comes with the pod's choices (`ResolveItems`):
 * file it where its kind lives, make the kind available here, file it as
 * another kind, or skip it. Approve and Reject are unchanged.
 */

import { addToast, Button } from "@heroui/react";
import { TriangleAlert } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { openIn } from "../../../lib/open-in";
import { proposalPageT } from "./copy";
import {
  kindMissingLine,
  stoppedGraphReport,
  stoppedHeader,
  type StoppedGraphReport,
  type StoppedItem,
} from "./stopped-graph-model";
import {
  resolveRows,
  resolvedToast,
  type ResolveAction,
  type ResolveRow,
} from "./resolve-item-model";
import {
  pickAct,
  repairRows,
  type RepairAct,
  type RepairOptionsField,
  type RepairRow,
} from "./repair-card-model";

function Row({
  row,
  busy,
  onRepair,
}: {
  row: RepairRow;
  busy: boolean;
  onRepair: (act: RepairAct) => void;
}) {
  const t = proposalPageT();
  const rest = row.choices.filter((c) => c !== row.suggested?.value);
  return (
    <li data-repair-field={row.key} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2 text-[13px]">
        <span className="font-medium text-foreground/85">{row.label}</span>
        {row.rejected.map((value) => (
          <span
            key={value}
            className="rounded bg-warning/10 px-1.5 py-0.5 text-[12px] text-warning-700 line-through decoration-warning/60"
          >
            {value}
          </span>
        ))}
      </div>
      {row.note && <p className="text-[12px] text-foreground/65">{row.note}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {row.suggested && (
          <Button
            size="sm"
            color="primary"
            isDisabled={busy}
            onPress={() => onRepair(row.suggested!.act)}
          >
            {t("repair.use", { value: row.suggested.value })}
          </Button>
        )}
        {rest.map((choice) => (
          <Button
            key={choice}
            size="sm"
            variant="flat"
            isDisabled={busy}
            onPress={() => onRepair(pickAct(row, choice))}
          >
            {choice}
          </Button>
        ))}
        {row.add && (
          <Button
            size="sm"
            variant="bordered"
            isDisabled={busy}
            onPress={() => onRepair(row.add!.act)}
          >
            {t("repair.add", { value: row.add.value })}
          </Button>
        )}
      </div>
    </li>
  );
}

function ItemLabel({ item }: { item: StoppedItem }) {
  const t = proposalPageT();
  return (
    <>
      {item.entityId ? (
        <a
          href={
            openIn({ kind: "object", objectKind: "entity", id: item.entityId })
              .href
          }
          className="text-foreground/85 underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/60"
        >
          {item.label}
        </a>
      ) : (
        <span className="text-foreground/85">{item.label}</span>
      )}
      {item.linked && (
        <span className="text-foreground/50"> · {t("stopped.linked")}</span>
      )}
    </>
  );
}

/** What a graph that stopped part-way filed, failed on and never tried. */
export function StoppedGraph({ report }: { report: StoppedGraphReport }) {
  const t = proposalPageT();
  const failedReason = report.kindMissing
    ? kindMissingLine(report.kindMissing, t)
    : report.failed?.reason;
  return (
    <div data-stopped-graph="" className="flex flex-col gap-3 text-[13px]">
      <p className="font-medium text-foreground/85">
        {stoppedHeader(report, t)}
      </p>
      {report.failed && (
        <div data-stopped-failed="" className="flex flex-col gap-1">
          <span className="text-[12px] text-foreground/55">
            {t("stopped.failed")}
          </span>
          <span>
            <ItemLabel item={report.failed} />
          </span>
          {failedReason && (
            <span className="text-[12px] text-foreground/70">
              {failedReason}
            </span>
          )}
        </div>
      )}
      {report.landed.length > 0 && (
        <div data-stopped-landed="" className="flex flex-col gap-1">
          <span className="text-[12px] text-foreground/55">
            {t("stopped.landed")}
          </span>
          <ul className="flex flex-col gap-0.5">
            {report.landed.map((item) => (
              <li key={item.key}>
                <ItemLabel item={item} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.skipped.length > 0 && (
        <div data-stopped-skipped="" className="flex flex-col gap-1">
          <span className="text-[12px] text-foreground/55">
            {t("stopped.skipped")}
          </span>
          <ul className="flex flex-col gap-0.5">
            {report.skipped.map((item) => (
              <li key={item.key}>
                <ItemLabel item={item} />
                <span className="text-[12px] text-foreground/55">
                  {" "}
                  · {item.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.notRun.length > 0 && (
        <div data-stopped-not-run="" className="flex flex-col gap-1">
          <span className="text-[12px] text-foreground/55">
            {t("stopped.notRun")}
          </span>
          <ul className="flex flex-col gap-0.5 text-foreground/65">
            {report.notRun.map((item) => (
              <li key={item.key}>{item.label}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The item a stopped graph waits on, with the pod's choices
 * (`proposals.resolveOptions`, `resolve-item-model.ts`), recommended first.
 * A press sends `proposals.resolveItem`: the pod files that one item and the
 * links that need it, then what never ran; the landed records are never
 * filed again. The proposal is then read afresh.
 */
function ResolveItems({
  proposalId,
  onDecided,
}: {
  proposalId: string;
  onDecided: () => void;
}) {
  const t = proposalPageT();
  const utils = trpc.useUtils();
  const options = trpc.proposals.resolveOptions.useQuery({ proposalId });
  const resolve = trpc.proposals.resolveItem.useMutation({
    onSuccess: (result) => {
      void utils.proposals.invalidate();
      addToast(resolvedToast(result, t));
      if (result.complete) onDecided();
    },
    onError: (e) => {
      void utils.proposals.invalidate();
      addToast({
        title: t("resolve.failed"),
        description: e.message,
        color: "danger",
        timeout: Infinity,
      });
    },
  });
  if (options.isError) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-foreground/65">
        <span>{t("resolve.loadFailed")}</span>
        <Button
          size="sm"
          variant="light"
          onPress={() => void options.refetch()}
        >
          {t("read.retry")}
        </Button>
      </div>
    );
  }
  if (options.isLoading) {
    return (
      <p className="text-[12px] text-foreground/55">{t("resolve.loading")}</p>
    );
  }
  const rows = resolveRows(options.data, t);
  if (rows.length === 0) return null;
  const press = (row: ResolveRow, action: ResolveAction) =>
    resolve.mutate({ proposalId, itemRef: row.itemRef, action });
  return (
    <section
      aria-label={t("resolve.label")}
      data-resolve-items=""
      className="flex flex-col gap-3"
    >
      {rows.map((row) => (
        <div
          key={row.itemRef}
          data-resolve-item={row.itemRef}
          className="flex flex-col gap-2 text-[13px]"
        >
          <span className="font-medium text-foreground/85">{row.title}</span>
          {row.heldNote && (
            <span className="text-[12px] text-foreground/65">
              {row.heldNote}
            </span>
          )}
          {row.dependentsNote && (
            <span className="text-[12px] text-foreground/55">
              {row.dependentsNote}
            </span>
          )}
          <ul className="flex flex-col gap-1.5">
            {row.choices.map((choice) => (
              <li
                key={choice.key}
                className="flex flex-wrap items-center gap-2"
              >
                <Button
                  size="sm"
                  color={choice.recommended ? "primary" : "default"}
                  variant={choice.recommended ? "solid" : "flat"}
                  isDisabled={resolve.isPending}
                  onPress={() => press(row, choice.action)}
                >
                  {choice.label}
                </Button>
                {choice.recommended && (
                  <span className="text-[12px] text-foreground/55">
                    {t("resolve.recommended")}
                    {choice.hint ? ` · ${choice.hint}` : ""}
                  </span>
                )}
                {!choice.recommended && choice.hint && (
                  <span className="text-[12px] text-foreground/55">
                    {choice.hint}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export function FailedApproval({
  proposalId,
  reason,
  expectedRevision,
  onDecided,
  data,
  graph,
}: {
  proposalId: string;
  /** `renderedRevision` of the proposal this page drew: a revise after it refuses the repair. */
  expectedRevision: number;
  /** The pod's classified sentence for the failure, when it recorded one. */
  reason: string | null;
  onDecided: () => void;
  /** The proposal's stored payload (`data.materialized` says what a stopped graph filed). */
  data?: unknown;
  /** The pod's review graph, for the items' titles. */
  graph?: unknown;
}) {
  const stopped = stoppedGraphReport({ data, graph });
  const utils = trpc.useUtils();
  const t = proposalPageT();
  const options = trpc.proposals.repairOptions.useQuery({ proposalId });
  const failed = (title: string) => (e: { message: string }) => {
    void utils.proposals.invalidate();
    addToast({
      title,
      description: e.message,
      color: "danger",
      timeout: Infinity,
    });
  };
  const approve = trpc.proposals.approve.useMutation({
    onSuccess: () => {
      void utils.proposals.invalidate();
      addToast({ title: t("repair.approved"), color: "success" });
      onDecided();
    },
    onError: failed(t("repair.approveFailed")),
  });
  const repair = trpc.proposals.repair.useMutation({
    onSuccess: (result) =>
      approve.mutate({ proposalId, expectedRevision: result.revision }),
    onError: failed(t("repair.failed")),
  });
  const busy = repair.isPending || approve.isPending;

  const rows =
    options.data?.repairable === true
      ? repairRows(options.data.fields as RepairOptionsField[])
      : [];

  return (
    <section
      aria-label={t("repair.label")}
      data-failed-approval=""
      className="flex flex-col gap-3 rounded-lg bg-warning/[0.06] px-4 py-3 ring-1 ring-inset ring-warning/25"
    >
      <p className="flex items-start gap-2 text-[13px] text-foreground/85">
        <TriangleAlert
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-warning"
        />
        <span>{reason ?? t("repair.default")}</span>
      </p>
      {stopped && <StoppedGraph report={stopped} />}
      {stopped && (
        <ResolveItems proposalId={proposalId} onDecided={onDecided} />
      )}
      {options.isError ? (
        <div className="flex items-center gap-2 text-[12px] text-foreground/65">
          <span>{t("repair.loadFailed")}</span>
          <Button
            size="sm"
            variant="light"
            onPress={() => void options.refetch()}
          >
            {t("read.retry")}
          </Button>
        </div>
      ) : options.isLoading ? (
        <p className="text-[12px] text-foreground/55">{t("repair.checking")}</p>
      ) : rows.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <Row
              key={row.key}
              row={row}
              busy={busy}
              onRepair={(act) =>
                repair.mutate({
                  proposalId,
                  expectedRevision,
                  set: act.set ?? {},
                  ...(act.addOption ? { addOption: act.addOption } : {}),
                })
              }
            />
          ))}
        </ul>
      ) : options.data?.missingKind ? (
        <p className="text-[12px] text-foreground/65">
          {t("repair.missingKind", { kind: options.data.missingKind })}
        </p>
      ) : null}
    </section>
  );
}
