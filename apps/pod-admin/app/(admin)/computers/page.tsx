"use client";

/**
 * Access › Computers — every member's computers (`machines.adminList`, pod
 * admin), how long their keys last, and the agents each one runs. The pod
 * default key lifetime sits in the header. `?status=` filters by key state;
 * `?focus=<computerId>` is received by the rows. Members see their own on
 * `/my-computers`, drawn by the same list.
 */

import { Suspense, useEffect } from "react";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { navHref } from "../../../lib/console-nav";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import { ComputerList } from "./_lib/computer-list";
import {
  PodKeyLifetimeAction,
  usePodKeyDefaults,
} from "./_lib/pod-key-lifetime";

const TITLE = "Computers";
const DESCRIPTION =
  "The machines that run your agents, and how long their keys last.";

export default function ComputersPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <ComputersInner />
    </Suspense>
  );
}

function ComputersInner() {
  const list = trpc.machines.adminList.useQuery(undefined, {
    staleTime: 30_000,
  });
  const me = trpc.users.me.useQuery(undefined, { staleTime: 300_000 });
  const defaults = usePodKeyDefaults();

  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);
  const isAuthRedirecting = list.error?.data?.code === "UNAUTHORIZED";

  return (
    <PageShell>
      <PageHeader
        title={TITLE}
        description={DESCRIPTION}
        actions={<PodKeyLifetimeAction defaults={defaults} />}
      />
      <ComputerList
        computers={list.data}
        isLoading={list.isLoading || isAuthRedirecting}
        isError={list.isError && !isAuthRedirecting}
        onRetry={() => void list.refetch()}
        hrefFor={(id) => `${navHref("computers")}/${encodeURIComponent(id)}`}
        showOwner
        viewerId={me.data?.id ?? null}
      />
    </PageShell>
  );
}
