"use client";

/**
 * The mark above the audit log when it shows what went through without a
 * proof of presence: the lens's name (and the kind's words), the window, and
 * a door back to the whole audit log.
 */

import Link from "next/link";
import { ShieldAlert, X } from "lucide-react";
import { useT } from "../../../../lib/i18n/locale-provider";
import { CATALOGS } from "./copy";
import {
  PRESENCE_MISSING_DAYS,
  presenceKindWords,
  type PresenceMissingLens,
} from "./presence-missing-link";

export function PresenceMissingMark({ lens }: { lens: PresenceMissingLens }) {
  const t = useT(CATALOGS);
  const name = lens.kind
    ? t("lens.kind", { kind: presenceKindWords(lens.kind) })
    : t("lens.all");
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="inline-flex items-center rounded-md bg-foreground/[0.08] ring-1 ring-inset ring-foreground/15">
        <span className="inline-flex h-8 items-center gap-1.5 px-2.5 text-[12.5px] font-medium tracking-tight text-foreground">
          <ShieldAlert className="h-3.5 w-3.5 text-warning" aria-hidden />
          {name}
        </span>
        <Link
          href="/audit"
          aria-label={t("lens.clear")}
          title={t("lens.clear")}
          className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <span className="text-[11.5px] text-foreground/65">
        {t("lens.window", { days: PRESENCE_MISSING_DAYS })}
      </span>
    </div>
  );
}
