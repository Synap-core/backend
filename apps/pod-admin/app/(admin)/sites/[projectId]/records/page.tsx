"use client";

/** `/sites/[projectId]/records` — every record of a site ("Show all"). */

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { PageFallback, PageShell } from "../../../components/page-header";
import { SiteAllRecords } from "../../_lib/site-all-items";

export default function SiteRecordsRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Suspense fallback={<PageFallback />}>
      <PageShell>
        <SiteAllRecords projectId={projectId} />
      </PageShell>
    </Suspense>
  );
}
