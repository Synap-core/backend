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
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, type ReactNode } from "react";
import { navHref, navLabel } from "../../../lib/console-nav";
import { trpc } from "../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../lib/auth-redirect";
import { formatRelative } from "../../../lib/format";
import { MD_UP, useMediaQuery } from "../../../lib/use-media-query";
import { FilterChips } from "../components/filter-chips";
import { PageFallback, PageHeader, PageShell } from "../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
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
  const router = useRouter();
  const params = useSearchParams();
  const via: ViaFilter = parseVia(params.get("via")) ?? "all";
  const wide = useMediaQuery(MD_UP);

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
  const open = (row: AppRowView) => router.push(row.href);

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
            className="flex min-h-10 items-center justify-between gap-3 rounded-lg bg-status-stale/10 px-3 py-2 text-[12.5px] text-foreground ring-1 ring-inset ring-status-stale/30 transition-colors hover:bg-status-stale/15"
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
          ) : wide ? (
            <AppTable rows={shown} onOpen={open} />
          ) : (
            <AppRows rows={shown} onOpen={open} />
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

function lastUsed(row: AppRowView): string {
  return formatRelative(row.lastUsedAt, { empty: "Never" });
}

const TABLE_COLUMNS =
  "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,1.1fr)] items-center gap-3";

/** md and up: the apps as a table, one line per app. */
function AppTable({
  rows,
  onOpen,
}: {
  rows: readonly AppRowView[];
  onOpen: (row: AppRowView) => void;
}) {
  return (
    <div role="table" aria-label="Apps" className="-mx-2">
      <div
        role="row"
        className={`${TABLE_COLUMNS} border-b border-foreground/[0.06] px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65`}
      >
        <div role="columnheader">App</div>
        <div role="columnheader">How it connects</div>
        <div role="columnheader">Who</div>
        <div role="columnheader">What it can reach</div>
        <div role="columnheader">Last used</div>
        <div role="columnheader">Status</div>
      </div>
      <div role="rowgroup" className="divide-y divide-foreground/[0.05]">
        {rows.map((row) => (
          <div
            key={`${row.via}:${row.id}`}
            role="row"
            data-row-id={row.id}
            className={`${TABLE_COLUMNS} min-h-12 rounded-md px-2 py-2 text-[12.5px] transition-colors hover:bg-foreground/[0.03]`}
          >
            <div role="cell" className="flex min-w-0 flex-col">
              <button
                type="button"
                onClick={() => onOpen(row)}
                className="max-w-full truncate rounded-sm text-left text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {row.name}
              </button>
              {row.publisher && (
                <span className="truncate text-[11.5px] text-foreground/65">
                  by {row.publisher}
                </span>
              )}
            </div>
            <div role="cell" className="min-w-0">
              <ViaChip via={row.via} />
            </div>
            <Cell>{row.who}</Cell>
            <div
              role="cell"
              className="line-clamp-2 min-w-0 text-foreground/65"
              title={row.reach}
            >
              {row.reach}
            </div>
            <Cell>{lastUsed(row)}</Cell>
            <div role="cell" className="min-w-0">
              <StatusPill kind={row.status.kind} label={row.status.label} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Cell({ children }: { children: ReactNode }) {
  return (
    <div role="cell" className="min-w-0 truncate text-foreground/65">
      {children}
    </div>
  );
}

/** Phones: the house row, the model and the facts in its second line. */
function AppRows({
  rows,
  onOpen,
}: {
  rows: readonly AppRowView[];
  onOpen: (row: AppRowView) => void;
}) {
  return (
    <div className="-mx-2 divide-y divide-foreground/[0.05]">
      {rows.map((row) => (
        <div
          key={`${row.via}:${row.id}`}
          data-row-id={row.id}
          className="rounded-md transition-shadow"
        >
          <ResourceRow
            Icon={SquareCode}
            primary={row.name}
            secondary={[
              VIA_LABEL[row.via],
              row.who,
              `Last used ${lastUsed(row).toLowerCase()}`,
            ].join(" · ")}
            status={row.status}
            onSelect={() => onOpen(row)}
            wrap
          />
        </div>
      ))}
    </div>
  );
}

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
