"use client";

/**
 * Marketplace — what the catalog offers, what changed in what you installed,
 * and where the catalog comes from. One page, three views on `?tab=`
 * (UrlTabs): `catalog` (default), `updates` and `sources`.
 * What is already ON the pod (installed capabilities, their actions, skills)
 * is the Tools page (`/tools`); the old `?tab=installed` and `?tab=tools`
 * links redirect there (`console-nav.ts`).
 */

import { Suspense } from "react";
import { trpc } from "../../../lib/trpc";
import { PageHeader, PageShell } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { ResourceRowSkeleton } from "../components/resource-row";
import { CatalogTab } from "./_lib/catalog-tab";
import { SourcesTab } from "./_lib/sources-tab";
import { tabLabel } from "./_lib/catalog-model";
import { UpdatesTab } from "./updates/_lib/updates-tab";
import { usePackageUpdateList } from "./updates/_lib/use-package-updates";
import { waitingUpdates } from "./updates/_lib/updates-model";
import { useT } from "../../../lib/i18n/locale-provider";
import { en, fr } from "./updates/_lib/copy";

const UPDATES_CATALOGS = { en, fr };

const TITLE = "Marketplace";
const DESCRIPTION =
  "Packages you can install, what changed in what you installed, and where they come from.";

export default function MarketplacePage() {
  // Tab counts read the cache the tabs fill (same query keys), never a fetch
  // of their own: a count appears once its tab has loaded, and stays.
  const sources = trpc.marketplace.sources.list.useQuery(undefined, {
    enabled: false,
  });
  // The updates waiting are counted from the same read the tab, the Review
  // page and Home use: the number on the tab is the number of rows waiting.
  const updates = usePackageUpdateList();
  const t = useT(UPDATES_CATALOGS);

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
              key: "updates",
              label: tabLabel(
                t("tab.updates"),
                updates.data
                  ? waitingUpdates(updates.data.updates).length
                  : undefined
              ),
              content: <UpdatesTab />,
            },
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
