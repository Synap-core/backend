"use client";

/**
 * Tools — every tool on this pod in ONE list (decision 79f5b7a2, contract
 * a0f787b7): search, type chips (All · Capabilities · Instructions · Code),
 * a list / gallery switch, and every row opens its tool's own page. "Tools"
 * is the user word for capabilities and skills (concepts.md, founder D2); a
 * capability's actions live on its page. What can be installed is
 * Marketplace.
 *
 * The three tabs this page had (`?tab=installed|actions|skills`) are gone:
 * an old link lands on its filter, or on the capability it focused
 * (`legacyToolsHref`).
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { useT } from "../../../lib/i18n/locale-provider";
import { PageHeader, PageShell } from "../components/page-header";
import { ResourceRowSkeleton } from "../components/resource-row";
import { TOOLS_CATALOGS } from "./_lib/copy";
import { legacyToolsHref } from "./_lib/tools-model";
import { ToolsList } from "./_lib/tools-list";

export default function ToolsPage() {
  const t = useT(TOOLS_CATALOGS);
  return (
    <PageShell>
      <PageHeader title={t("title")} description={t("description")} />
      {/* The list and the old-link receiver read the URL. */}
      <Suspense fallback={<ResourceRowSkeleton count={5} />}>
        <ToolsBody />
      </Suspense>
    </PageShell>
  );
}

function ToolsBody() {
  const router = useRouter();
  const params = useSearchParams();
  const legacy = legacyToolsHref(new URLSearchParams(params.toString()));
  useEffect(() => {
    if (legacy) router.replace(legacy);
  }, [legacy, router]);
  if (legacy) return <ResourceRowSkeleton count={5} />;
  return <ToolsList />;
}
