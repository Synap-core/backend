"use client";

/**
 * "What did our AIs do yesterday?" (PA-D-03): the person's latest morning
 * brief, at the top of Home, with a door to Historique for what was decided.
 *
 * The brief is a notification the pod raises once a day
 * (`ai.proactive.morning_briefing`, pod-wide), so it is read from the
 * person's own notifications (`notifCenter.list`, floored on the caller): the
 * newest of their pod-wide AI notifications, read or not. Its title and body
 * are the pod's text, shown as written. Empty (no brief raised yet) and
 * failed (the read broke, with a retry) are two states.
 */

import { Button } from "@heroui/react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatRelative } from "@synap-core/types/value-format";
import { navHref } from "../../../../lib/console-nav";
import { useConsoleLocale, useT } from "../../../../lib/i18n/locale-provider";
import { trpc } from "../../../../lib/trpc";
import {
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { en, fr } from "./copy";
import { latestBrief } from "./morning-brief-model";

const CATALOGS = { en, fr };
/** Pod-wide AI notifications read to find the newest brief (one a day). */
const SCAN = 20;

export function MorningBriefCard() {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const list = trpc.notifCenter.list.useQuery(
    { status: "all", category: "ai", workspaceId: null, limit: SCAN },
    { staleTime: 300_000 }
  );
  const brief = latestBrief(list.data?.notifications ?? []);

  return (
    <SectionCard
      title={t("brief.title")}
      hint={
        brief
          ? t("brief.hint", {
              when: formatRelative(brief.createdAt, Date.now(), { locale }),
            })
          : undefined
      }
      actions={
        <Button
          as={Link}
          href={navHref("history")}
          size="sm"
          variant="flat"
          radius="md"
          endContent={<ChevronRight className="h-3 w-3" aria-hidden />}
        >
          {t("brief.history")}
        </Button>
      }
    >
      {list.isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : list.isError ? (
        <ResourceRowError
          message={t("brief.failed")}
          onRetry={() => void list.refetch()}
        />
      ) : brief ? (
        <div className="flex flex-col gap-1 px-1 py-1">
          <p className="text-[14px] font-medium text-foreground">
            {brief.title}
          </p>
          {brief.body && (
            <p className="whitespace-pre-line text-[13px] leading-5 text-foreground/80">
              {brief.body}
            </p>
          )}
        </div>
      ) : (
        <ResourceRowEmpty message={t("brief.empty")} />
      )}
    </SectionCard>
  );
}
