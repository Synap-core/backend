"use client";

/**
 * `/sites/[projectId]` — one project's site: its state, its link, what it
 * publishes. The body is `SitePage` (`../_lib/site-page.tsx`).
 */

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { PageFallback, PageShell } from "../../components/page-header";
import { SitePage } from "../_lib/site-page";

export default function SiteRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    // The tabs read `useSearchParams`, which Next 16 wants under Suspense.
    <Suspense fallback={<PageFallback />}>
      <PageShell>
        <SitePage projectId={projectId} />
      </PageShell>
    </Suspense>
  );
}
