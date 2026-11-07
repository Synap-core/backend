"use client";

/**
 * The head of "Ways to confirm it's you" on the person's Security page and
 * the onboarding step: the title, how many they hold out of the two
 * `enforce` keeps, and the one sentence that says what that means. A failed
 * count is said, with Try again; it never reads as "none".
 */
import { Button } from "@heroui/react";
import { StatusPill } from "../../../(admin)/components/status-pill";
import { useT } from "../../../../lib/i18n/locale-provider";
import { en, fr } from "./copy";
import { useWaysIn } from "./use-ways-in";
import { WAYS_IN_ANCHOR, waysInMark } from "./ways-in-model";

const CATALOGS = { en, fr };

export function WaysInHeader() {
  const t = useT(CATALOGS);
  const { state, retry } = useWaysIn();
  const mark = waysInMark(state);
  return (
    <header id={WAYS_IN_ANCHOR} className="flex scroll-mt-6 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold text-foreground">
          {t("waysIn.title")}
        </h2>
        {mark ? (
          <StatusPill
            kind={mark.tone}
            label={t("waysIn.count", { count: mark.count, of: mark.of })}
          />
        ) : null}
      </div>
      <p className="text-[13px] text-foreground/65">{t("waysIn.hint")}</p>
      {state.kind === "failed" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-[12.5px] text-status-down">
            {t("waysIn.failed")}
          </p>
          <Button size="sm" variant="flat" radius="md" onPress={retry}>
            {t("waysIn.retry")}
          </Button>
        </div>
      ) : mark ? (
        <p
          className={
            mark.tone === "stale"
              ? "text-[13px] font-medium text-warning"
              : "text-[13px] text-foreground/80"
          }
        >
          {t(mark.line)}
        </p>
      ) : null}
    </header>
  );
}
