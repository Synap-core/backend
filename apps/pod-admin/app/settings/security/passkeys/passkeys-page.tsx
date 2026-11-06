"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useT } from "../../../../lib/i18n/locale-provider";
import { en, fr } from "../../../_lib/passkeys/copy";
import { PasskeysCard } from "../../../_lib/passkeys/passkeys-card";
import { PASSKEYS_PATH } from "../passkeys-path";

const CATALOGS = { en, fr };

/** The passkeys card alone, with its way back to Security. */
export function PasskeysPage() {
  const t = useT(CATALOGS);
  return (
    <div className="mx-auto max-w-[760px] px-6 py-10">
      <header className="mb-6 flex flex-col gap-1.5">
        <Link
          href="/settings/security"
          className="inline-flex min-h-10 items-center gap-1 self-start text-[12.5px] text-foreground/60 hover:text-foreground"
        >
          <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
          {t("passkeys.page.back")}
        </Link>
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          {t("passkeys.title")}
        </h1>
        <p className="text-[13px] text-foreground/60">
          {t("passkeys.page.lead")}
        </p>
      </header>
      <PasskeysCard returnTo={PASSKEYS_PATH} />
    </div>
  );
}
