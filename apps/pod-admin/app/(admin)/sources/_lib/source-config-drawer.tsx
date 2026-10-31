"use client";

/**
 * The drawer a pod-level source config opens (`/sources`): the facts of the
 * `sourceConfigs.list` row, a "Test connection" that shows exactly what the
 * probe returned, and a door to the app, where a source is edited. Words in
 * `copy.ts`, shaping in `source-config-model.ts`.
 */

import { Button } from "@heroui/react";
import { AlertTriangle, CheckCircle2, Plug } from "lucide-react";
import { useEffect, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { openIn } from "../../../../lib/open-in";
import { useT } from "../../../../lib/i18n/locale-provider";
import { formatRelative, formatTimestamp } from "../../../../lib/format";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { FactsGrid } from "../../../_lib/object/facts-grid";
import { DetailDrawer } from "../../components/detail-drawer";
import { HandoffCard } from "../../components/handoff-card";
import { SectionCard } from "../../components/section-card";
import { StatusPill } from "../../components/status-pill";
import { SOURCE_CATALOGS } from "./copy";
import {
  lastTestLine,
  scopeLabel,
  testCouldNotRun,
  testOutcome,
  type SourceConfigRow,
  type TestOutcome,
} from "./source-config-model";

export function SourceConfigDrawer({
  row,
  onClose,
}: {
  row: SourceConfigRow | null;
  onClose: () => void;
}) {
  const t = useT(SOURCE_CATALOGS);
  const utils = trpc.useUtils();
  // The answer belongs to the row it was asked for: opening another source
  // never shows the previous one's result.
  const [outcome, setOutcome] = useState<{
    id: string;
    result: TestOutcome;
  } | null>(null);
  useEffect(() => setOutcome(null), [row?.id]);

  const test = trpc.sourceConfigs.testConnection.useMutation({
    onSuccess: (res, vars) => {
      setOutcome({ id: vars.id, result: testOutcome(res, t) });
      // The probe persisted its verdict on the row: re-read the list.
      void utils.sourceConfigs.list.invalidate();
    },
    onError: (err, vars) => {
      if (redirectToLoginIfUnauthorized(err)) return;
      setOutcome({ id: vars.id, result: testCouldNotRun(err.message, t) });
    },
  });
  const shown = outcome && row && outcome.id === row.id ? outcome.result : null;

  return (
    <DetailDrawer
      isOpen={!!row}
      onClose={onClose}
      title={row?.name ?? t("drawer.fallbackTitle")}
      subtitle={row ? row.providerType : undefined}
    >
      {row ? (
        <div className="flex flex-col gap-4">
          <FactsGrid
            columns={2}
            facts={[
              {
                label: t("fact.status"),
                value: (
                  <StatusPill
                    kind={row.enabled ? "healthy" : "unknown"}
                    label={
                      row.enabled ? t("status.enabled") : t("status.disabled")
                    }
                  />
                ),
              },
              { label: t("fact.provider"), value: row.providerType },
              { label: t("fact.scope"), value: scopeLabel(row, t) },
              {
                label: t("fact.lastTest"),
                value: lastTestLine(row, formatRelative(row.lastTestedAt), t),
              },
              ...(row.createdAt
                ? [
                    {
                      label: t("fact.created"),
                      value: formatTimestamp(row.createdAt),
                    },
                  ]
                : []),
              { label: t("fact.id"), value: row.id, mono: true },
            ]}
          />
          {row.description ? (
            <p className="text-[12.5px] leading-relaxed text-foreground/65">
              {row.description}
            </p>
          ) : null}

          <SectionCard title={t("test.title")} hint={t("test.hint")}>
            <div className="flex flex-col gap-3">
              <div>
                <Button
                  size="sm"
                  radius="md"
                  variant="flat"
                  isLoading={test.isPending}
                  onPress={() => test.mutate({ id: row.id })}
                >
                  {test.isPending ? t("test.running") : t("test.button")}
                </Button>
              </div>
              {shown && (
                <p
                  role="status"
                  className={[
                    "flex items-start gap-2 text-[12.5px] leading-relaxed",
                    shown.kind === "ok"
                      ? "text-status-healthy"
                      : "text-status-down",
                  ].join(" ")}
                >
                  {shown.kind === "ok" ? (
                    <CheckCircle2
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                      strokeWidth={2}
                      aria-hidden
                    />
                  ) : (
                    <AlertTriangle
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                      strokeWidth={2}
                      aria-hidden
                    />
                  )}
                  <span>{shown.message}</span>
                </p>
              )}
            </div>
          </SectionCard>

          <HandoffCard
            icon={Plug}
            title={t("edit.title")}
            body={t("edit.body")}
            exit={openIn({ kind: "settings", section: "connectors" })}
            cta={t("edit.cta")}
          />
        </div>
      ) : null}
    </DetailDrawer>
  );
}
