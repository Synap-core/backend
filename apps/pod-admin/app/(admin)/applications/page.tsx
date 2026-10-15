"use client";

/**
 * Apps — everything that connects to the pod, and what it can reach.
 *
 * One list over three doors, one per connection model (`_lib/app-inventory`):
 * key apps (`apps.adminList`), "Sign in with your pod" apps
 * (`applicationConnections.list`) and Claude/MCP clients
 * (`oauthClients.adminList`). All three are pod-admin reads. A door that
 * fails leaves its rows out with a note, never the whole list.
 *
 * Waiting requests are NOT decided here: the banner counts and names them and
 * sends the reader to Review, the one attention door. `?via=` is the filter,
 * `?focus=<id>` lands on a row; a row opens `/applications/<via>/<id>`.
 */

import { Accordion, AccordionItem, Button } from "@heroui/react";
import { ArrowRight, Plus, SquareCode } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, type ReactNode } from "react";
import { navHref, navLabel } from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { FilterChips } from "../components/filter-chips";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import {
  ResponsiveTable,
  type TableColumn,
} from "../components/responsive-table";
import { SectionCard } from "../components/section-card";
import { StatusPill } from "../components/status-pill";
import { statusPillFor } from "../components/status-tone";
import { useFocusRow } from "../components/use-focus-row";
import {
  APP_VIAS,
  VIA_LABEL,
  buildInventory,
  countByVia,
  headline,
  parseVia,
  pendingSummary,
  type AppRowView,
  type AppVia,
} from "./_lib/app-inventory";
import {
  requestStateLabel,
  signInRequestHref,
  splitSignInRequests,
  type SignInRequestLike,
} from "./_lib/sign-in-requests";
import { ViaChip } from "./_lib/via-chip";

const DESCRIPTION =
  "Everything that connects to your pod, and what it can reach.";

/** Where every waiting access request is decided. */
const ACCESS_REVIEW_HREF = navHref("review", { type: "access" });

type ViaFilter = "all" | AppVia;

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<PageFallback />}>
      <ApplicationsInner />
    </Suspense>
  );
}

function ApplicationsInner() {
  const params = useSearchParams();
  const via: ViaFilter = parseVia(params.get("via")) ?? "all";

  const keyApps = trpc.apps.adminList.useQuery(undefined, {
    staleTime: 30_000,
  });
  const signIns = trpc.applicationConnections.list.useQuery(undefined, {
    staleTime: 30_000,
  });
  const clients = trpc.oauthClients.adminList.useQuery(undefined, {
    staleTime: 30_000,
  });
  const reads = [keyApps, signIns, clients] as const;

  const unauthorized = reads.find(
    (r) => r.error?.data?.code === "UNAUTHORIZED"
  )?.error;
  useEffect(() => {
    if (unauthorized) redirectToLoginIfUnauthorized(unauthorized);
  }, [unauthorized]);

  const loading = reads.some((r) => r.isLoading) || Boolean(unauthorized);
  useFocusRow({ ready: !loading });

  const rows = useMemo(
    () =>
      buildInventory({
        keyApps: keyApps.data ?? [],
        signIns: signIns.data?.connections ?? [],
        clients: clients.data ?? [],
      }),
    [keyApps.data, signIns.data, clients.data]
  );
  const counts = countByVia(rows);
  const shown = via === "all" ? rows : rows.filter((r) => r.via === via);
  const waiting = pendingSummary({
    keyApps: keyApps.data ?? [],
    requests: signIns.data?.requests ?? [],
  });
  const failed = (
    [
      ["key", keyApps],
      ["sign-in", signIns],
      ["mcp", clients],
    ] as const
  ).filter(([, r]) => r.isError && !unauthorized);
  const allFailed = failed.length === reads.length;

  return (
    <PageShell>
      <PageHeader
        title={navLabel("apps")}
        description={DESCRIPTION}
        actions={
          // Connecting is the member's own act (their key, their app), so it
          // opens the self-service door, not an admin form.
          <Button
            as={Link}
            href="/connect"
            size="sm"
            variant="flat"
            radius="md"
            className="min-h-9"
            startContent={<Plus className="h-3.5 w-3.5" />}
          >
            Connect an app
          </Button>
        }
      />

      <FilterChips<ViaFilter>
        param="via"
        defaultKey="all"
        active={via}
        ariaLabel="How it connects"
        chips={[
          {
            key: "all",
            label: "All",
            count: loading ? undefined : rows.length,
          },
          ...APP_VIAS.map((v) => ({
            key: v,
            label: VIA_LABEL[v],
            count: loading ? undefined : counts[v],
          })),
        ]}
      />

      <div className="flex flex-col gap-4">
        {waiting && (
          <Link
            href={ACCESS_REVIEW_HREF}
            className="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-status-stale/10 px-3 py-2 text-[12.5px] text-foreground ring-1 ring-inset ring-status-stale/30 transition-colors hover:bg-status-stale/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className="min-w-0">
              <span className="font-medium">
                {waiting.count} app request{waiting.count === 1 ? "" : "s"}{" "}
                waiting
              </span>
              <span className="block text-foreground/65">{waiting.line}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 font-medium">
              Review
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
          </Link>
        )}

        <SectionCard
          title={via === "all" ? "Connected apps" : VIA_LABEL[via]}
          hint={loading ? undefined : (headline(shown) ?? undefined)}
        >
          {loading ? (
            <ResourceRowSkeleton count={4} />
          ) : allFailed ? (
            <ResourceRowError
              message="Couldn't load apps."
              onRetry={() => reads.forEach((r) => void r.refetch())}
            />
          ) : shown.length === 0 ? (
            <ResourceRowEmpty message={emptyMessage(via, rows.length)} />
          ) : (
            <ResponsiveTable
              ariaLabel="Apps"
              rows={shown}
              rowKey={(row) => `${row.via}:${row.id}`}
              rowId={(row) => row.id}
              href={(row) => row.href}
              name={{
                header: "App",
                width: "minmax(0,1.6fr)",
                label: (row) => row.name,
                sub: (row) => (row.publisher ? `by ${row.publisher}` : null),
              }}
              columns={APP_COLUMNS}
              phone={(row) => ({
                Icon: SquareCode,
                secondary: [
                  VIA_LABEL[row.via],
                  row.who,
                  row.lastUsedAt
                    ? `Last used ${formatRelative(row.lastUsedAt)}`
                    : "Never used",
                ].join(" · "),
                status: row.status,
              })}
            />
          )}
          {!loading && !allFailed && failed.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-1 pt-3 text-[12px] text-status-down">
              Couldn&apos;t load{" "}
              {failed.map(([v]) => VIA_LABEL[v]).join(" or ")} apps, so they are
              missing here.
              <Button
                size="sm"
                variant="light"
                radius="md"
                onPress={() => failed.forEach(([, r]) => void r.refetch())}
              >
                Retry
              </Button>
            </div>
          )}
        </SectionCard>

        {(via === "all" || via === "sign-in") && (
          <SignInRequests requests={signIns.data?.requests ?? []} />
        )}

        <p className="max-w-2xl px-1 text-[12px] leading-5 text-foreground/65">
          &ldquo;Sign in with your pod&rdquo; apps act as the person who signed
          in and only see what that person can see. Key apps act as their owner,
          within the spaces the key names. Claude/MCP acts as the person who
          connected it, as an agent: the pod&apos;s agent rules decide which of
          its changes wait for review.
        </p>
      </div>
    </PageShell>
  );
}

function emptyMessage(via: ViaFilter, total: number): ReactNode {
  if (total === 0) {
    return "No app connects to this pod yet. Connect one, or sign in to an app with your pod.";
  }
  return `No app connects by ${VIA_LABEL[via as AppVia]}.`;
}

/** The table's columns after the app's name. */
const APP_COLUMNS: TableColumn<AppRowView>[] = [
  {
    header: "How it connects",
    width: "minmax(0,1.3fr)",
    className: "min-w-0",
    cell: (row) => <ViaChip via={row.via} />,
  },
  { header: "Who", width: "minmax(0,0.9fr)", cell: (row) => row.who },
  {
    header: "What it can reach",
    width: "minmax(0,2.2fr)",
    className: "line-clamp-2 min-w-0 text-foreground/65",
    cell: (row) => <span title={row.reach}>{row.reach}</span>,
  },
  {
    header: "Last used",
    width: "minmax(0,0.8fr)",
    cell: (row) => formatRelative(row.lastUsedAt, { empty: "Never" }),
  },
  {
    header: "Status",
    width: "minmax(0,1.1fr)",
    className: "min-w-0",
    cell: (row) => (
      <StatusPill kind={row.status.kind} label={row.status.label} />
    ),
  },
];

/**
 * Sign-in requests nobody here decides: started-but-unfinished, and the
 * archive. Collapsed — visibility, not work. Each opens its own page.
 */
function SignInRequests({
  requests,
}: {
  requests: readonly SignInRequestLike[];
}) {
  const { inProgress, archived } = splitSignInRequests(requests);
  const all = [...inProgress, ...archived];
  if (all.length === 0) return null;
  return (
    <Accordion className="px-0" variant="light">
      <AccordionItem
        key="requests"
        aria-label="Sign-in requests"
        title={
          <span className="text-[12.5px] text-foreground/65">
            Sign-in requests in progress and past ({all.length})
          </span>
        }
      >
        <p className="mb-2 max-w-2xl px-1 text-[12px] leading-5 text-foreground/65">
          Apps that started connecting but haven&apos;t finished, and requests
          that timed out, were declined or completed. Nothing here waits on you
          — a request that does is in Review.
        </p>
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {all.map((r) => (
            <ResourceRow
              key={r.id}
              Icon={SquareCode}
              primary={r.displayName}
              secondary={`${r.issuerUrl} · ${r.requestedOrigin}`}
              status={{
                kind: statusPillFor(r.status)?.kind ?? "unknown",
                label: requestStateLabel(r.status),
              }}
              actions={
                <Button
                  as={Link}
                  href={signInRequestHref(r.id)}
                  size="sm"
                  variant="flat"
                  radius="md"
                  className="min-h-9"
                >
                  View
                </Button>
              }
              wrap
            />
          ))}
        </div>
      </AccordionItem>
    </Accordion>
  );
}
