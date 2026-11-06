"use client";

/**
 * "What asks for your passkey" (W5, founder 6 Nov 2026): one switch per
 * sensitive approval and action, grouped by reason, stored per pod
 * (`presence.setSensitivity`). Pod admin RUNS the pod, so the choice lives
 * in Security, under "Approvals need you in person".
 *
 *  - The read is `presence.sensitivity`; a failed read is its own state with
 *    Try again, never every switch shown on.
 *  - Switching a row OFF asks for the person's passkey (bound to exactly the
 *    new choice) in every mode, and every pod admin is told; the hint says
 *    so before the press. Switching back ON is free.
 *  - The switch is the mark: a change that lands says nothing more; a
 *    refusal says so in one toast; declining the passkey changes nothing and
 *    says nothing (the dialog already did).
 */

import { useState } from "react";
import { Button, Switch, addToast } from "@heroui/react";
import { KeyRound } from "lucide-react";
import type {
  PresenceSensitivityChoice,
  SensitiveReason,
} from "@synap-core/types/presence";
import { trpc } from "../../../../lib/trpc";
import { formatRelative, readableError } from "../../../../lib/format";
import { useT } from "../../../../lib/i18n/locale-provider";
import { PresenceDeclined } from "../../../_lib/presence/presence-model";
import { useSetPresenceSensitivity } from "../../../_lib/presence/use-factor-doors";
import { SectionCard } from "../../components/section-card";
import { StatusPill } from "../../components/status-pill";
import { en, fr } from "./copy";
import {
  sensitivityView,
  withRow,
  type SensitivityRowView,
} from "./sensitivity-model";

const CATALOGS = { en, fr };

const REASON_WORD: Record<
  SensitiveReason,
  | "sensitivity.reason.deploy"
  | "sensitivity.reason.setup"
  | "sensitivity.reason.governance"
  | "sensitivity.reason.deletion"
> = {
  deploy: "sensitivity.reason.deploy",
  setup: "sensitivity.reason.setup",
  governance: "sensitivity.reason.governance",
  deletion: "sensitivity.reason.deletion",
};

export function SensitivityCard() {
  const t = useT(CATALOGS);
  const utils = trpc.useUtils();
  const read = trpc.presence.sensitivity.useQuery(undefined, {
    retry: false,
  });
  const setSensitivity = useSetPresenceSensitivity();
  const [pending, setPending] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<SensitiveReason>>(
    new Set()
  );

  const change = async (key: string, next: PresenceSensitivityChoice) => {
    if (!read.data || pending) return;
    setPending(key);
    try {
      await setSensitivity(read.data, next);
      await utils.presence.sensitivity.invalidate();
    } catch (err) {
      if (!(err instanceof PresenceDeclined)) {
        addToast({
          title: t("sensitivity.notChanged"),
          description:
            readableError((err as Error).message) ??
            t("sensitivity.notChangedHint"),
          color: "danger",
        });
      }
    } finally {
      setPending(null);
    }
  };

  const toggle = (row: SensitivityRowView, on: boolean) =>
    void change(`${row.kind}:${row.key}`, withRow(read.data, row, on));

  const view = read.data ? sensitivityView(read.data, { expanded }) : null;
  const label = (row: SensitivityRowView) =>
    row.prefix ? t("sensitivity.row.prefix", { name: row.label }) : row.label;

  return (
    <SectionCard
      title={t("sensitivity.title")}
      hint={t("sensitivity.hint")}
      actions={
        view ? (
          <StatusPill
            kind={view.anyOff ? "stale" : "healthy"}
            label={t("sensitivity.mark", {
              asking: view.asking,
              total: view.total,
            })}
            icon={KeyRound}
          />
        ) : null
      }
    >
      {read.isLoading ? (
        <div className="h-16 rounded-medium bg-foreground/[0.05] shimmer-pulse" />
      ) : read.isError || !view || !read.data ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[12.5px] text-status-down">
            {t("sensitivity.failed")}
          </p>
          <Button
            size="sm"
            variant="flat"
            radius="md"
            onPress={() => void read.refetch()}
          >
            {t("sensitivity.retry")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {read.data.mode === "report" ? (
            <p className="text-[12px] text-foreground/60">
              {t("sensitivity.reportNote")}
            </p>
          ) : null}
          {view.groups.map((group) => (
            <section
              key={group.reason}
              aria-labelledby={`sensitivity-${group.reason}`}
              className="flex flex-col gap-1.5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <h3
                  id={`sensitivity-${group.reason}`}
                  className="text-[13px] font-medium text-foreground/85"
                >
                  {t(REASON_WORD[group.reason])}
                </h3>
                <span className="text-[12px] tabular-nums text-foreground/55">
                  {t("sensitivity.group.count", {
                    asking: group.asking,
                    total: group.total,
                  })}
                </span>
              </div>
              <ul className="flex flex-col divide-y divide-foreground/[0.05]">
                {group.rows.map((row) => (
                  <li
                    key={`${row.kind}:${row.key}`}
                    className="flex items-center gap-3 py-1.5"
                  >
                    <span className="w-24 shrink-0 text-[11.5px] text-foreground/50">
                      {t(
                        row.kind === "approval"
                          ? "sensitivity.kind.approval"
                          : "sensitivity.kind.action"
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground/80">
                      {label(row)}
                    </span>
                    <Switch
                      size="sm"
                      isSelected={row.on}
                      isDisabled={pending !== null}
                      onValueChange={(on) => toggle(row, on)}
                      aria-label={t("sensitivity.row.switch", {
                        label: label(row),
                      })}
                    />
                  </li>
                ))}
              </ul>
              {group.more > 0 || expanded.has(group.reason) ? (
                <Button
                  size="sm"
                  variant="light"
                  radius="md"
                  className="self-start"
                  onPress={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.reason)) next.delete(group.reason);
                      else next.add(group.reason);
                      return next;
                    })
                  }
                >
                  {group.more > 0
                    ? t("sensitivity.showAll", { n: group.total })
                    : t("sensitivity.showFewer")}
                </Button>
              ) : null}
            </section>
          ))}
          {read.data.changedAt || view.anyOff ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-foreground/[0.05] pt-3">
              {read.data.changedAt ? (
                <p className="text-[12px] text-foreground/55">
                  {t("sensitivity.changedBy", {
                    when: formatRelative(read.data.changedAt),
                  })}
                </p>
              ) : null}
              {view.anyOff ? (
                <Button
                  size="sm"
                  variant="flat"
                  radius="md"
                  isDisabled={pending !== null}
                  isLoading={pending === "reset"}
                  onPress={() =>
                    void change("reset", { approvalsOff: [], actionsOff: [] })
                  }
                >
                  {t("sensitivity.reset")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
