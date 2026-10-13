"use client";

/**
 * Kinds — every kind the pod holds, how many of each, and what needs tidying.
 * Shaping in `kinds-model.ts`.
 *
 * Read-only but for one act: Retire a SPACE kind with no records, which files
 * a `profiles.proposeRetire` proposal in that space (sent with its
 * `X-Workspace-Id`, see `app/providers.tsx`) — the pod answers, and the answer
 * is shown as it came ("Sent to Review", or why not). Everything else —
 * editing a kind, merging twins, removing a field — is the app's Data ›
 * Kinds. `diagnose.global` is read with Home's own key and options, so the
 * three share one cached answer. `?focus=<profileId>` highlights a kind.
 */

import { Button, addToast } from "@heroui/react";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { navHref } from "../../../../lib/console-nav";
import { openIn } from "../../../../lib/open-in";
import {
  ExitFallback,
  ExitLink,
  usePlacedExit,
} from "../../../../lib/exit-link";
import { kindIcon } from "../../../_lib/object/kind-icon";
import { ConfirmModal } from "../../components/confirm-modal";
import { PageHeader, PageShell } from "../../components/page-header";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import { useFocusRow } from "../../components/use-focus-row";
import { DIAGNOSE_QUERY_OPTIONS } from "../../../../lib/diagnose-query";
import {
  KINDS_DESCRIPTION,
  KINDS_TITLE,
  kindRows,
  recordsLine,
  retireOutcome,
  schemaFindings,
  tidyItems,
  type KindRow,
  type TidyItem,
} from "./kinds-model";

/** The desktop app's Data app holds the kind editor (`apps/manifest.ts` "data"). */
const DATA_APP = openIn({ kind: "app", appId: "data" });

export function KindsPage() {
  const utils = trpc.useUtils();
  const profiles = trpc.profiles.list.useQuery(undefined, {
    staleTime: 60_000,
  });
  const counts = trpc.entities.adminListProfiles.useQuery(
    {},
    { staleTime: 60_000 }
  );
  const diagnose = trpc.diagnose.global.useQuery(
    undefined,
    DIAGNOSE_QUERY_OPTIONS
  );
  const workspaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
  });

  useEffect(() => {
    if (profiles.error) redirectToLoginIfUnauthorized(profiles.error);
  }, [profiles.error]);
  useFocusRow({ ready: !profiles.isLoading });

  const findings = useMemo(
    () => schemaFindings(diagnose.data?.sections),
    [diagnose.data]
  );
  const rows = useMemo(
    () =>
      kindRows(
        profiles.data?.profiles ?? [],
        counts.isSuccess ? counts.data : null,
        findings,
        new Map((workspaces.data ?? []).map((w) => [w.id, w.name] as const))
      ),
    [profiles.data, counts.isSuccess, counts.data, findings, workspaces.data]
  );
  const items = useMemo(() => tidyItems(rows, findings), [rows, findings]);

  // ── Retire (the one act) ───────────────────────────────────────────────────
  const [confirming, setConfirming] = useState<TidyItem | null>(null);
  const [outcomes, setOutcomes] = useState<
    Record<string, { message: string; proposalId: string | null }>
  >({});
  const retire = useMutation({
    mutationFn: (a: { profileId: string; workspaceId: string }) =>
      utils.client.profiles.proposeRetire.mutate(
        { id: a.profileId },
        { context: { workspaceId: a.workspaceId } }
      ),
    onSuccess: (res, a) => {
      const key = `zero:${a.profileId}`;
      setOutcomes((o) => ({ ...o, [key]: retireOutcome(res) }));
      setConfirming(null);
      void utils.diagnose.global.invalidate();
      void utils.signals.invalidate();
    },
    onError: (err: { message: string; data?: { code?: string } }) => {
      setConfirming(null);
      if (redirectToLoginIfUnauthorized(err)) return;
      addToast({
        title: "That kind wasn’t sent to Review",
        description: err.message,
        color: "danger",
      });
    },
  });

  return (
    <PageShell>
      <PageHeader
        title={KINDS_TITLE}
        description={KINDS_DESCRIPTION}
        actions={<ExitLink exit={DATA_APP} label="Edit kinds in app" />}
      />

      <div className="flex flex-col gap-4">
        <TidySection
          loading={diagnose.isLoading}
          failed={diagnose.isError}
          onRetry={() => void diagnose.refetch()}
          items={items}
          outcomes={outcomes}
          onRetire={setConfirming}
        />

        <section
          aria-label="Every kind"
          className="divide-y divide-foreground/[0.05] rounded-lg bg-foreground/[0.02] ring-1 ring-inset ring-foreground/10"
        >
          {profiles.isLoading ? (
            <ResourceRowSkeleton count={6} />
          ) : profiles.isError ? (
            <ResourceRowError
              message="Couldn't load the pod's kinds."
              onRetry={() => void profiles.refetch()}
            />
          ) : rows.length === 0 ? (
            <ResourceRowEmpty message="This pod has no kinds yet." />
          ) : (
            rows.map((row) => <KindRowView key={row.id} row={row} />)
          )}
        </section>
        {counts.isError && (
          <p className="px-1 text-[12px] text-foreground/65">
            Record counts couldn’t be read; they show as “—”.
          </p>
        )}
      </div>

      <ConfirmModal
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() =>
          confirming?.action.kind === "retire" &&
          retire.mutate({
            profileId: confirming.action.profileId,
            workspaceId: confirming.action.workspaceId,
          })
        }
        title={`Retire ${confirming?.title ?? "this kind"}?`}
        consequence={
          <>
            This sends a proposal to Review. Once approved, the kind is hidden
            in every space and from agents. Nothing is deleted, and it can be
            brought back.
          </>
        }
        confirmLabel="Send to Review"
        confirmColor="warning"
        isPending={retire.isPending}
      />
    </PageShell>
  );
}

function KindRowView({ row }: { row: KindRow }) {
  const Icon = kindIcon(row.slug, {
    slug: row.slug,
    label: row.name,
    uiHints: row.profile.uiHints as { icon?: string | null } | null,
    profileKind: row.profile.profileKind,
  });
  return (
    <div data-row-id={row.id} className="rounded-md">
      <ResourceRow
        Icon={Icon}
        primary={row.name}
        secondary={[row.scope, recordsLine(row), row.slug].join(" · ")}
        status={row.pill ?? undefined}
        wrap
      />
    </div>
  );
}

function TidySection({
  loading,
  failed,
  onRetry,
  items,
  outcomes,
  onRetire,
}: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  items: TidyItem[];
  outcomes: Record<string, { message: string; proposalId: string | null }>;
  onRetire: (item: TidyItem) => void;
}) {
  // `null` on a phone: the mobile app cannot open the desktop Data app, so the
  // row offers no dead link and the line beneath the list says why.
  const appHref = usePlacedExit(DATA_APP).href;
  if (loading)
    return (
      <SectionCard title="Needs tidying">
        <ResourceRowSkeleton count={2} />
      </SectionCard>
    );
  if (failed)
    return (
      <SectionCard title="Needs tidying">
        <ResourceRowError
          message="Couldn't check what needs tidying."
          onRetry={onRetry}
        />
      </SectionCard>
    );
  if (items.length === 0) return null;
  const anyInApp = items.some((i) => i.action.kind === "app");
  return (
    <SectionCard
      title="Needs tidying"
      hint={`${items.length} ${items.length === 1 ? "thing" : "things"} worth a look`}
    >
      <ul className="-mx-2 flex flex-col">
        {items.map((item) => {
          const outcome = outcomes[item.key];
          return (
            <li
              key={item.key}
              className="flex flex-col gap-2 border-b border-foreground/[0.05] px-2 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium text-foreground">
                  {item.focusId ? (
                    <Link
                      href={navHref("kinds", { focus: item.focusId })}
                      className="hover:underline"
                    >
                      {item.title}
                    </Link>
                  ) : (
                    item.title
                  )}
                </span>
                <span className="text-[12.5px] leading-relaxed text-foreground/65">
                  {item.sentence}
                </span>
                {outcome && (
                  <span className="text-[12.5px] text-foreground" role="status">
                    {outcome.message}{" "}
                    {outcome.proposalId && (
                      <Link
                        href={navHref("review", { focus: outcome.proposalId })}
                        className="font-medium text-primary hover:underline"
                      >
                        Open in Review
                      </Link>
                    )}
                  </span>
                )}
              </div>
              <div className="shrink-0">
                {item.action.kind === "retire" ? (
                  <Button
                    size="sm"
                    variant="flat"
                    radius="md"
                    isDisabled={outcome !== undefined}
                    onPress={() => onRetire(item)}
                  >
                    Retire
                  </Button>
                ) : appHref === null ? null : (
                  <Button
                    as="a"
                    href={appHref}
                    size="sm"
                    variant="flat"
                    radius="md"
                    endContent={
                      <ArrowUpRight
                        className="h-3 w-3"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    }
                  >
                    Open in app
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {anyInApp && (
        <div className="pt-2 text-[12px]">
          <ExitFallback exit={DATA_APP} />
        </div>
      )}
    </SectionCard>
  );
}
