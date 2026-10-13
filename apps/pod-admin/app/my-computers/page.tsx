"use client";

/**
 * /my-computers — the computers YOU connected (D9), and how long their keys
 * last. Self-service, like `/my-connections` and `/my-vault`: the read is
 * `machines.list`, floored to the computers you approved, and every act on
 * one (`rename` / `setKeyTtl` / `revoke`) re-loads it and refuses anyone but
 * its owner or a pod admin — see the `/my-computers` line in route-policy.
 *
 * Drawn by the same list as the admin's Access › Computers, without the
 * Owner column and the pod-wide key lifetime (a pod admin's setting).
 */

import { Suspense, useEffect } from "react";
import { trpc } from "../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../lib/auth-redirect";
import {
  PageFallback,
  PageHeader,
  PageShell,
} from "../(admin)/components/page-header";
import { ComputerList } from "../(admin)/computers/_lib/computer-list";

export default function MyComputersPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <MyComputersInner />
    </Suspense>
  );
}

function MyComputersInner() {
  const list = trpc.machines.list.useQuery(undefined, { staleTime: 30_000 });

  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  return (
    <PageShell>
      <PageHeader
        title="My computers"
        description="The machines you connected to this pod, the agents they run, and how long their keys last."
      />
      <ComputerList
        computers={list.data}
        isLoading={list.isLoading || isAuthRedirecting}
        isError={list.isError && !isAuthRedirecting}
        onRetry={() => void list.refetch()}
        hrefFor={(id) => `/my-computers/${encodeURIComponent(id)}`}
        showOwner={false}
        viewerId={null}
      />
    </PageShell>
  );
}
