"use client";

import { useT } from "../../../../lib/i18n/locale-provider";
import { PageHeader, PageShell } from "../../components/page-header";
import { en, fr } from "./copy";
import { HistoryList } from "./history-list";

const CATALOGS = { en, fr };

export function HistoryPage() {
  const t = useT(CATALOGS);
  return (
    <PageShell>
      <PageHeader title={t("title")} description={t("description")} />
      <HistoryList />
    </PageShell>
  );
}
