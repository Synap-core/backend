"use client";

/**
 * /my-devices — the computers YOU connected, and how long their keys
 * last. Self-service, like `/my-connections` and `/my-vault`: the read is
 * `machines.list`, floored to the computers you approved, and every act on
 * one (`rename` / `setKeyTtl` / `revoke`) re-loads it and refuses anyone but
 * its owner or a pod admin — see the `/my-devices` line in route-policy.
 *
 * Drawn by the same list as the admin's Access › Devices, without the
 * Owner column and the pod-wide key lifetime (a pod admin's setting), in
 * the narrower column of the other self-service pages.
 */

import { Suspense, useEffect } from "react";
import { trpc } from "../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../lib/auth-redirect";
import { navHref, navLabel } from "../../lib/console-nav";
import {
  PageHeader,
  PageShell,
  PageSkeleton,
} from "../(admin)/components/page-header";
import { ComputerList } from "../(admin)/devices/_lib/computer-list";
import { Breadcrumbs } from "../_lib/object/object-header";
import { useT } from "../../lib/i18n/locale-provider";
import { en, fr } from "../(admin)/components/copy";

const SHELL_CATALOGS = { en, fr };

export default function MyComputersPage() {
  return (
    <Suspense
      fallback={
        <PageShell width="personal">
          <PageSkeleton />
        </PageShell>
      }
    >
      <MyComputersInner />
    </Suspense>
  );
}

function MyComputersInner() {
  const t = useT(SHELL_CATALOGS);
  const list = trpc.machines.list.useQuery(undefined, { staleTime: 30_000 });

  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  return (
    <PageShell width="personal">
      <div className="mb-3">
        {/* Where the console starts for every member (Home). */}
        <Breadcrumbs
          crumbs={[
            { label: navLabel("home"), href: navHref("home") },
            { label: t("user.devices") },
          ]}
        />
      </div>
      <PageHeader
        title={t("user.devices")}
        description="The machines you connected to this pod, the agents they run, and how long their keys last."
      />
      <ComputerList
        computers={list.data}
        isLoading={list.isLoading || isAuthRedirecting}
        isError={list.isError && !isAuthRedirecting}
        onRetry={() => void list.refetch()}
        hrefFor={(id) => `/my-devices/${encodeURIComponent(id)}`}
        showOwner={false}
        viewerId={null}
      />
    </PageShell>
  );
}
