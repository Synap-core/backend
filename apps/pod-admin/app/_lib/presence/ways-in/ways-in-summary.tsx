"use client";

/**
 * Pod security's line about the person's OWN ways to confirm it's them: the
 * count and its sentence, and the door to the one place they are managed
 * (`/settings/security`). Pod security holds the pod's rules; the person's
 * ways in are listed once, on their Security page (founder, 7 Nov 2026,
 * session 539e519b).
 */
import Link from "next/link";
import { Button } from "@heroui/react";
import { SectionCard } from "../../../(admin)/components/section-card";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { useT } from "../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import { useWaysIn } from "./use-ways-in";
import { WAYS_IN_HREF, waysInMark } from "./ways-in-model";

const CATALOGS = { en, fr };

export function WaysInSummary() {
  const t = useT(CATALOGS);
  const { state, retry } = useWaysIn();
  const mark = waysInMark(state);
  return (
    <SectionCard
      title={t("waysIn.summary")}
      actions={
        mark ? (
          <StatusPill
            kind={mark.tone}
            label={t("waysIn.count", { count: mark.count, of: mark.of })}
          />
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        {state.kind === "failed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="alert" className="text-[12.5px] text-status-down">
              {t("waysIn.failed")}
            </p>
            <Button size="sm" variant="flat" radius="md" onPress={retry}>
              {t("waysIn.retry")}
            </Button>
          </div>
        ) : state.kind === "loading" ? (
          <div className="h-5 w-1/2 rounded-md bg-foreground/[0.06] shimmer-pulse" />
        ) : (
          <p
            className={
              mark?.tone === "stale"
                ? "text-[13px] font-medium text-warning"
                : "text-[13px] text-foreground/80"
            }
          >
            {mark ? t(mark.line) : null}
          </p>
        )}
        <Button
          as={Link}
          href={WAYS_IN_HREF}
          size="sm"
          variant="flat"
          radius="md"
        >
          {t("waysIn.manage")}
        </Button>
      </div>
    </SectionCard>
  );
}
