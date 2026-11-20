"use client";

/**
 * One daily write limit: the number as the title, who · where (an agent is a
 * door to its page) and, for an "approve and allow today" raise, that it ends
 * at midnight; today's use against it as the mark (one agent's limit only:
 * `governanceCeilings.usageToday`, the counter the gate reads); Take back.
 */

import { Button } from "@heroui/react";
import { Gauge } from "lucide-react";
import Link from "next/link";
import { useCallback } from "react";
import { trpc } from "../../../../../lib/trpc";
import { agentHref } from "../../../../../lib/console-nav";
import { useT } from "../../../../../lib/i18n/locale-provider";
import {
  limitEndsAt,
  limitSpaceId,
  limitUsage,
  type LimitRowLike,
  type LimitWho,
} from "../../../../../lib/governance-ceilings/limits-model";
import { ResourceRow } from "../../../components/resource-row";
import type { StatusKind } from "../../../components/status-pill";
import { en, fr } from "./copy";

const CATALOGS = { en, fr };

/** Who a limit caps, in words (an unnamed agent is "An agent", never an id). */
export function useWhoWords(): (who: LimitWho) => string {
  const t = useT(CATALOGS);
  return useCallback(
    (who: LimitWho) =>
      who.kind === "any"
        ? t("who.any")
        : who.kind === "computers"
          ? t("who.computers")
          : (who.name ?? t("who.unnamed")),
    [t]
  );
}

export function LimitLine({
  row,
  who,
  where,
  onTakeBack,
}: {
  row: LimitRowLike;
  who: LimitWho;
  where: string;
  onTakeBack: () => void;
}) {
  const t = useT(CATALOGS);
  const whoWords = useWhoWords();
  const whoText = whoWords(who);
  const endsTonight = limitEndsAt(row) !== null;
  const agentId = who.kind === "agent" ? who.agentUserId : null;
  const usage = trpc.governanceCeilings.usageToday.useQuery(
    {
      agentUserId: agentId ?? "",
      ...(limitSpaceId(row) ? { workspaceId: limitSpaceId(row)! } : {}),
    },
    { enabled: agentId !== null, staleTime: 30_000 }
  );
  const gauge = limitUsage(usage.data?.count, row.limitValue);
  const inForce = usage.data?.limit ?? null;

  const status: { kind: StatusKind; label: string } | undefined = usage.isError
    ? { kind: "unknown", label: t("row.usageFailed") }
    : gauge
      ? {
          kind: gauge.reached ? "down" : gauge.warn ? "stale" : "healthy",
          label: gauge.reached
            ? t("row.reached")
            : t("row.today", { used: gauge.used, limit: gauge.limit }),
        }
      : undefined;

  return (
    <div data-row-id={row.id} className="rounded-md transition-shadow">
      <ResourceRow
        Icon={Gauge}
        primary={t("row.perDay", { count: row.limitValue })}
        secondary={
          <>
            {agentId ? (
              <Link
                href={agentHref(agentId)}
                className="text-foreground/85 underline-offset-2 hover:underline"
              >
                {whoText}
              </Link>
            ) : (
              whoText
            )}
            {" · "}
            {where}
            {endsTonight && <> · {t("row.untilMidnight")}</>}
            {/* The gate applies the limit it resolves; say when it is not this one. */}
            {inForce !== null && inForce !== row.limitValue && (
              <> · {t("row.otherInForce", { limit: inForce })}</>
            )}
          </>
        }
        status={status}
        wrap
        actions={
          <Button
            size="sm"
            variant="flat"
            radius="md"
            className="min-h-9"
            aria-label={t("takeBack.aria", { who: whoText })}
            onPress={onTakeBack}
          >
            {t("takeBack.label")}
          </Button>
        }
      />
    </div>
  );
}
