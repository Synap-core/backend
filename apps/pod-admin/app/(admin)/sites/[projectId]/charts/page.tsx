"use client";

/** `/sites/[projectId]/charts` — every chart of a site ("Show all"). */

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { PageFallback, PageShell } from "../../../components/page-header";
import { SiteAllCharts } from "../../_lib/site-all-items";

export default function SiteChartsRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Suspense fallback={<PageFallback />}>
      <PageShell>
        <SiteAllCharts projectId={projectId} />
      </PageShell>
    </Suspense>
  );
}
