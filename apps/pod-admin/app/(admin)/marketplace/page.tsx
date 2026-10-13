"use client";

/**
 * Marketplace — what the Synap catalog offers, what this pod has installed,
 * and which installed verbs are turned on. One page, three views on `?tab=`
 * (UrlTabs): `catalog` (default), `installed`, `tools`. Home's capabilities
 * row and the Installed tab's "Turn on" land on `?tab=tools`.
 */

import { Suspense } from "react";
import { PageHeader, PageShell } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { ResourceRowSkeleton } from "../components/resource-row";
import { CatalogTab } from "./_lib/catalog-tab";
import { InstalledTab } from "./_lib/installed-tab";
import { ToolsTab } from "./_lib/tools-tab";

const TITLE = "Marketplace";
const DESCRIPTION =
  "Install from the Synap catalog, see what this pod has installed, and choose which of its tools are turned on.";

export default function MarketplacePage() {
  return (
    <PageShell>
      <PageHeader title={TITLE} description={DESCRIPTION} />
      {/* `UrlTabs` and the tabs' `?focus=` receivers read the URL. */}
      <Suspense fallback={<ResourceRowSkeleton count={4} />}>
        <UrlTabs
          param="tab"
          ariaLabel="Marketplace sections"
          tabs={[
            { key: "catalog", label: "Catalog", content: <CatalogTab /> },
            { key: "installed", label: "Installed", content: <InstalledTab /> },
            { key: "tools", label: "Tools", content: <ToolsTab /> },
          ]}
        />
      </Suspense>
    </PageShell>
  );
}
