"use client";

/**
 * Marketplace — what the catalog offers, what this pod has installed,
 * which installed verbs are turned on, and where the catalog comes from. One
 * page, four views on `?tab=`
 * (UrlTabs): `catalog` (default), `installed`, `tools`, `sources`. Home's capabilities
 * row and the Installed tab's "Turn on" land on `?tab=tools`.
 */

import { Suspense } from "react";
import { PageHeader, PageShell } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { ResourceRowSkeleton } from "../components/resource-row";
import { CatalogTab } from "./_lib/catalog-tab";
import { InstalledTab } from "./_lib/installed-tab";
import { ToolsTab } from "./_lib/tools-tab";
import { SourcesTab } from "./_lib/sources-tab";

const TITLE = "Marketplace";
const DESCRIPTION =
  "Install from the catalog, see what this pod has installed, choose which of its tools are turned on, and decide where packages come from.";

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
            { key: "sources", label: "Sources", content: <SourcesTab /> },
          ]}
        />
      </Suspense>
    </PageShell>
  );
}
