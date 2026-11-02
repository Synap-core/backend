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
 */

import { addToast, Button } from "@heroui/react";
import { TriangleAlert } from "lucide-react";
import { trpc } from "../../../lib/trpc";
import { proposalPageT } from "./copy";
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

export function FailedApproval({
  proposalId,
  reason,
  expectedRevision,
  onDecided,
}: {
  proposalId: string;
  /** `renderedRevision` of the proposal this page drew: a revise after it refuses the repair. */
  expectedRevision: number;
  /** The pod's classified sentence for the failure, when it recorded one. */
  reason: string | null;
  onDecided: () => void;
}) {
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
