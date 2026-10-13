"use client";

/**
 * Marketplace — what the catalog offers, what this pod has installed,
 * which installed verbs are turned on, and where the catalog comes from. One
 * page, four views on `?tab=`
 * (UrlTabs): `catalog` (default), `installed`, `tools`, `sources`. Home's capabilities
 * row and the Installed tab's "Turn on" land on `?tab=tools`.
 */

import { Suspense } from "react";
import { trpc } from "../../../lib/trpc";
import { PageHeader, PageShell } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { ResourceRowSkeleton } from "../components/resource-row";
import { CatalogTab } from "./_lib/catalog-tab";
import { InstalledTab } from "./_lib/installed-tab";
import { ToolsTab } from "./_lib/tools-tab";
import { SourcesTab } from "./_lib/sources-tab";
import { tabLabel } from "./_lib/catalog-model";

const TITLE = "Marketplace";
const DESCRIPTION = "Packages you can install, and where they come from.";

export default function MarketplacePage() {
  // Tab counts read the cache the tabs fill (same query keys), never a fetch
  // of their own: a count appears once its tab has loaded, and stays.
  const installed = trpc.capabilities.compositions.useQuery(undefined, {
    enabled: false,
  });
  const sources = trpc.marketplace.sources.list.useQuery(undefined, {
    enabled: false,
  });

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
            {
              key: "installed",
              label: tabLabel("Installed", installed.data?.length),
              content: <InstalledTab />,
            },
            { key: "tools", label: "Tools", content: <ToolsTab /> },
            {
              key: "sources",
              label: tabLabel("Sources", sources.data?.length),
              content: <SourcesTab />,
            },
          ]}
        />
      </Suspense>
    </PageShell>
  );
}
