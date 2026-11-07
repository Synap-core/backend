"use client";

/**
 * Sites — every site of a project you administer: where each one stands
 * (a chip on every row, Live included), what it holds, and the door to its
 * own page, where it goes live and where its link is. Design 73df57f3, A.
 */

import { Suspense } from "react";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import { SitesList } from "./_lib/sites-list";

const TITLE = "Sites";
const DESCRIPTION =
  "A project can publish one site. See which are live, what each publishes, and get its link.";

export default function SitesPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <PageShell>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <SitesList />
      </PageShell>
    </Suspense>
  );
}
