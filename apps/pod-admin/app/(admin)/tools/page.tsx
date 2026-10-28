"use client";

/**
 * Tools — what is ON this pod. "Tools" is the user word for capabilities and
 * skills (concepts.md, founder D2). Three views on `?tab=` (UrlTabs):
 * `installed` (default: every installed capability), `actions` (each
 * capability's verbs, turned on or off) and `skills` (every skill, the ones
 * waiting to be turned on first). What can be installed is Marketplace.
 * Home's "verbs not turned on" row and the Installed tab's "Turn on" land on
 * `?tab=actions`; the old Marketplace `?tab=installed` / `?tab=tools` links
 * redirect here (`console-nav.ts`).
 */

import { Suspense } from "react";
import { trpc } from "../../../lib/trpc";
import { PageHeader, PageShell } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { ResourceRowSkeleton } from "../components/resource-row";
import { tabLabel } from "../marketplace/_lib/catalog-model";
import { InstalledTab } from "./_lib/installed-tab";
import { ActionsTab } from "./_lib/actions-tab";
import { SkillsTab } from "./_lib/skills-tab";

const TITLE = "Tools";
const DESCRIPTION =
  "What this pod can do: installed capabilities, their actions, and skills.";

export default function ToolsPage() {
  // Tab counts read the cache the tabs fill (same query keys), never a fetch
  // of their own: a count appears once its tab has loaded, and stays.
  const installed = trpc.capabilities.compositions.useQuery(undefined, {
    enabled: false,
  });

  return (
    <PageShell>
      <PageHeader title={TITLE} description={DESCRIPTION} />
      {/* `UrlTabs` and the tabs' `?focus=` receivers read the URL. */}
      <Suspense fallback={<ResourceRowSkeleton count={4} />}>
        <UrlTabs
          param="tab"
          ariaLabel="Tools sections"
          tabs={[
            {
              key: "installed",
              label: tabLabel("Installed", installed.data?.length),
              content: <InstalledTab />,
            },
            { key: "actions", label: "Actions", content: <ActionsTab /> },
            { key: "skills", label: "Skills", content: <SkillsTab /> },
          ]}
        />
      </Suspense>
    </PageShell>
  );
}
