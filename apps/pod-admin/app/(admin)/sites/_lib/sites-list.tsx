"use client";

/**
 * The Sites list (`shares.listSites`): one row per site, each with its chip
 * (`siteMark`, the one site model), needs-you first. A row opens the site's
 * own page, the only place it goes live.
 *
 * States: loading (skeleton rows), failed (error with retry), no site at all
 * (EXPLAIN: an agent sets a site up, the person approves it in Requests),
 * one or many sites, and more than the read's cap (said in the hint).
 */

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Globe, Inbox } from "lucide-react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatDate } from "../../../../lib/format";
import { openIn } from "../../../../lib/open-in";
import { HandoffCard } from "../../components/handoff-card";
import {
  ResourceRow,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { orderSites, siteMark, siteRowFacts } from "./site-model";
import { navHref, siteHref } from "../../../../lib/console-nav";

export function SitesList() {
  const router = useRouter();
  const sites = trpc.shares.listSites.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (sites.isError) redirectToLoginIfUnauthorized(sites.error);
  }, [sites.isError, sites.error]);
  const isAuthRedirecting = sites.error?.data?.code === "UNAUTHORIZED";

  const rows = useMemo(
    () => orderSites(sites.data?.sites ?? []),
    [sites.data?.sites]
  );

  if (sites.isLoading || isAuthRedirecting) {
    return (
      <SectionCard title="Sites">
        <ResourceRowSkeleton count={3} />
      </SectionCard>
    );
  }
  if (sites.isError) {
    return (
      <SectionCard title="Sites">
        <ResourceRowError
          message="Couldn't read your sites."
          onRetry={() => void sites.refetch()}
        />
      </SectionCard>
    );
  }
  if (rows.length === 0) {
    return <NoSite />;
  }

  const truncated = sites.data?.truncated ?? false;
  return (
    <SectionCard
      title="Sites"
      hint={
        truncated
          ? `The ${rows.length} newest; more exist`
          : String(rows.length)
      }
    >
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        {rows.map((site) => {
          const mark = siteMark(site);
          const facts = siteRowFacts(site);
          if (mark.key === "live" || mark.key === "changed") {
            if (site.publishedAt) {
              facts.push(`since ${formatDate(site.publishedAt)}`);
            }
          }
          return (
            <ResourceRow
              key={site.siteId}
              Icon={Globe}
              primary={site.projectName}
              secondary={facts.join(" · ")}
              status={{ kind: mark.kind, label: mark.label }}
              onSelect={() => router.push(siteHref(site.projectId))}
            />
          );
        })}
      </div>
    </SectionCard>
  );
}

/** EXPLAIN: only an agent sets a site up; the person approves it in Requests. */
function NoSite() {
  return (
    <div className="flex flex-col gap-3">
      <HandoffCard
        icon={Globe}
        title="No project has a site yet"
        body="An agent sets up a site for a project and you approve it in Requests. Then you put it live here and get its link."
        exit={openIn({ kind: "app", appId: "data" })}
        cta="Open Synap"
      />
      <div>
        <Button
          as="a"
          href={navHref("review")}
          size="sm"
          radius="md"
          variant="flat"
          startContent={<Inbox className="h-3.5 w-3.5" />}
        >
          Open Requests
        </Button>
      </div>
    </div>
  );
}
