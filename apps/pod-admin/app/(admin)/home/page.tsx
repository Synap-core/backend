"use client";

/**
 * Home — where the console opens. It answers "what needs me?" first.
 *
 *   1. Status line   — one sentence from `diagnose.global` + failing sync
 *                      peers, when the pod was last checked, and "Check
 *                      again".
 *   2. Needs you     — the non-ok diagnose sections plus failing sync peers,
 *                      ranked and capped (`_lib/needs-you.ts`). Passing
 *                      checks collapse into one disclosure. Pending trusted
 *                      issuers are decisions: they wait in Review.
 *   3. Approval queue — a short peek into Review, never a second queue:
 *                      every row and the count lead into `/review`.
 *   4. Pod at a glance — sync, backups and contents as three compact rows.
 *
 * Members (D8) get 1–3 scoped to themselves: `diagnose` and `signals` are
 * user-floored, the sync peers and the glance band read admin-only
 * procedures, and rows whose page a member cannot open are dropped.
 *
 * Every band owns its queries and its loading/error state: one failing read
 * must never blank the page. Every number shown is one a procedure actually
 * returns — a card that advertises a number nobody computes teaches the
 * reader the app is broken, exactly as a permanently disabled button does.
 */

import { Button } from "@heroui/react";
import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock,
  Database,
  GitBranch,
  HardDrive,
  Layers,
  Mailbox,
  PackageCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  buildObjectActionTitle,
  resolveObjectNoun,
} from "@synap-core/types/vocabulary";
import Link from "next/link";
import { useState } from "react";

import { ExitFallback } from "../../../lib/exit-link";
import {
  formatRelative,
  humanizeBytes,
  truncateMiddle,
} from "../../../lib/format";
import { navHref, navLabel } from "../../../lib/console-nav";
import type { Exit } from "../../../lib/open-in";
import { trpc } from "../../../lib/trpc";
import { PageHeader, PageShell } from "../components/page-header";
import { RecoveryCodesNudge } from "../components/recovery-codes-nudge";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../components/resource-row";
import { SectionCard } from "../components/section-card";
import { DIAGNOSE_QUERY_OPTIONS } from "../../../lib/diagnose-query";
import { useConsoleBadges } from "../components/side-nav-badges";
import { useConsoleRole } from "../components/side-nav-role";
import { StatusPill, type StatusKind } from "../components/status-pill";
import { HEALTH_PILL } from "../components/status-tone";
import { buildNeedsYou, statusLine, type NeedsYouRow } from "./_lib/needs-you";

export default function HomePage() {
  const isAdmin = useConsoleRole() === "admin";
  return (
    <PageShell>
      <PageHeader
        title={navLabel("home")}
        description={
          isAdmin
            ? "What needs you, then the pod at a glance."
            : "What needs you on this pod."
        }
      />

      <RecoveryCodesNudge />

      <NeedsYouBand isAdmin={isAdmin} />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ApprovalQueueCard isAdmin={isAdmin} />
        {isAdmin && <GlanceCard />}
      </div>
    </PageShell>
  );
}

// ─── 1–2. Status line + Needs you ─────────────────────────────────────

const SECTION_ICONS: Record<string, LucideIcon> = {
  review_backlog: Mailbox,
  capabilities: PackageCheck,
  failed_flows: AlertTriangle,
  stuck_runs: Clock,
  sync_error: GitBranch,
  agent_activity: Bot,
  duplicate_proposals: Layers,
  review_queue: Activity,
  quality_by_prompt_version: Sparkles,
  schema_hygiene: Wrench,
  schema_contract: Database,
};

function NeedsYouBand({ isAdmin }: { isAdmin: boolean }) {
  const diagnose = trpc.diagnose.global.useQuery(
    undefined,
    DIAGNOSE_QUERY_OPTIONS
  );
  // Sync peers are not a diagnose section. Admin-gated (`podAdminProcedure`),
  // so a member never asks for them.
  const sync = trpc.sync.getStatus.useQuery(undefined, {
    staleTime: 60_000,
    enabled: isAdmin,
  });

  const needsYou = buildNeedsYou({
    audience: isAdmin ? "admin" : "member",
    sections: diagnose.data?.sections ?? [],
    syncErrors: (sync.data ?? []).flatMap((p) =>
      p.syncState?.lastError
        ? [
            {
              id: p.id,
              label: p.label ?? p.peerPodUrl,
              error: String(p.syncState.lastError),
            },
          ]
        : []
    ),
  });

  // Each source that failed is named, with its own retry, under whatever the
  // others produced.
  const failures: Array<{ key: string; message: string; retry: () => void }> =
    [];
  if (diagnose.isError) {
    failures.push({
      key: "diagnose",
      message: "Couldn't run the pod health checks.",
      retry: () => void diagnose.refetch(),
    });
  }
  if (sync.isError) {
    failures.push({
      key: "sync",
      message: "Couldn't load sync peers.",
      retry: () => void sync.refetch(),
    });
  }

  const loading = diagnose.isLoading || sync.isLoading;
  const utils = trpc.useUtils();
  // Every band on Home reads through tRPC, so one invalidate re-asks them all.
  const checkAgain = () => void utils.invalidate();
  const checking = diagnose.isFetching || sync.isFetching;
  // A status line computed without the health checks would say "All good"
  // about a pod nobody checked — so it waits for diagnose, and says so when
  // diagnose failed.
  const line = diagnose.data
    ? statusLine(diagnose.data.status, needsYou)
    : null;

  return (
    <>
      <div className="mb-4 flex min-h-8 flex-wrap items-center gap-3">
        {diagnose.isLoading ? (
          <div className="h-4 w-64 rounded bg-foreground/10 shimmer-pulse" />
        ) : line ? (
          <>
            <StatusPill
              kind={HEALTH_PILL[line.tone].kind}
              label={HEALTH_PILL[line.tone].label}
            />
            <p className="text-[13px] text-foreground">{line.sentence}</p>
          </>
        ) : (
          <p className="text-[13px] text-foreground/65">
            Pod health is unknown right now.
          </p>
        )}
        {!diagnose.isLoading && (
          <p className="flex items-center gap-1.5 text-[12.5px] text-foreground/65 sm:ml-auto">
            {diagnose.dataUpdatedAt > 0 && (
              <>
                <span>
                  Checked {formatRelative(new Date(diagnose.dataUpdatedAt))}
                </span>
                <span aria-hidden>·</span>
              </>
            )}
            <Button
              size="sm"
              variant="light"
              radius="md"
              isLoading={checking}
              onPress={checkAgain}
              className="h-8 min-w-0 px-2 text-[12.5px] text-foreground/80"
            >
              Check again
            </Button>
          </p>
        )}
      </div>

      <SectionCard title="Needs you" hint="Ranked: most urgent first">
        {loading && needsYou.rows.length === 0 ? (
          <ResourceRowSkeleton count={3} />
        ) : (
          <>
            {needsYou.rows.length === 0 && failures.length === 0 && (
              <div className="flex flex-col items-center gap-2 px-3 py-6">
                <CircleCheck
                  className="h-5 w-5 text-status-healthy"
                  strokeWidth={2}
                  aria-hidden
                />
                <p className="text-[12.5px] text-foreground/65">
                  Nothing needs you.
                </p>
              </div>
            )}
            {needsYou.rows.length > 0 && (
              <div className="-mx-2 divide-y divide-foreground/[0.05]">
                {needsYou.rows.map((row) => (
                  <NeedsYouRowView key={row.key} row={row} />
                ))}
              </div>
            )}
            <HiddenRows rows={needsYou.hiddenRows} />
            <DesktopFallbackOnce rows={needsYou.rows} />
            {failures.map((f) => (
              <ResourceRowError
                key={f.key}
                message={f.message}
                onRetry={f.retry}
              />
            ))}
            <PassingChecks passing={needsYou.passing} />
          </>
        )}
      </SectionCard>
    </>
  );
}

function NeedsYouRowView({ row }: { row: NeedsYouRow }) {
  const [open, setOpen] = useState(false);
  // Only the urgent rows wear a pill: the list is already ranked, and below
  // `sm` the row drops it (via `wrap`) so the headline keeps the room.
  const pill = row.tone === "degraded" ? HEALTH_PILL.degraded : undefined;

  let action = null;
  if (row.action.kind === "link") {
    action = <ActionLink exit={row.action.exit} label={row.action.label} />;
  } else if (row.action.kind === "expand") {
    action = (
      <Button
        size="sm"
        variant="flat"
        radius="md"
        aria-expanded={open}
        onPress={() => setOpen((v) => !v)}
        endContent={
          <ChevronDown
            className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          />
        }
      >
        {row.action.label}
      </Button>
    );
  }

  return (
    <div>
      <ResourceRow
        Icon={SECTION_ICONS[row.key] ?? AlertTriangle}
        primary={row.headline}
        secondary={row.secondary}
        status={pill}
        actions={action}
        wrap
      />
      {open && row.items.length > 0 && (
        <ul className="mb-2 ml-10 mr-3 flex flex-col gap-1">
          {row.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-baseline justify-between gap-x-3 text-[12.5px]"
            >
              {item.exit ? (
                <ItemLink exit={item.exit} label={item.label} />
              ) : (
                <span className="truncate text-foreground">{item.label}</span>
              )}
              {item.meta && (
                <span className="text-foreground/65">{item.meta}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The row's one primary action. A console route navigates in place via
 * `Link`; an `openIn` desktop exit is a plain anchor (the `synap://` handler
 * is the OS's, not Next's), with its fallback offered once beneath the list.
 */
function ActionLink({ exit, label }: { exit: Exit; label: string }) {
  return (
    <Button
      as={exit.isDesktopLink ? "a" : Link}
      href={exit.href}
      size="sm"
      variant="flat"
      radius="md"
      endContent={<ChevronRight className="h-3 w-3" />}
    >
      {label}
    </Button>
  );
}

const ITEM_LINK_CLASS =
  "truncate rounded-sm text-foreground hover:underline " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

function ItemLink({ exit, label }: { exit: Exit; label: string }) {
  return exit.isDesktopLink ? (
    <a href={exit.href} className={ITEM_LINK_CLASS}>
      {label}
    </a>
  ) : (
    <Link href={exit.href} className={ITEM_LINK_CLASS}>
      {label}
    </Link>
  );
}

/** "Get the desktop app", once, when any row or item hands off to it. */
function DesktopFallbackOnce({ rows }: { rows: NeedsYouRow[] }) {
  const desktopExit = rows
    .flatMap((r) => [
      r.action.kind === "link" ? r.action.exit : undefined,
      ...r.items.map((i) => i.exit),
    ])
    .find((e): e is Exit => Boolean(e?.isDesktopLink));
  if (!desktopExit) return null;
  return (
    <div className="mt-1 flex justify-end px-1">
      <ExitFallback exit={desktopExit} />
    </div>
  );
}

/** "+N more, less urgent" — a disclosure that reveals the rows past the cap. */
function HiddenRows({ rows }: { rows: NeedsYouRow[] }) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-1 text-[12.5px] text-foreground/65 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        +{rows.length} more, less urgent
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {rows.map((row) => (
            <NeedsYouRowView key={row.key} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function PassingChecks({
  passing,
}: {
  passing: Array<{ key: string; headline: string }>;
}) {
  const [open, setOpen] = useState(false);
  if (passing.length === 0) return null;
  return (
    <div className="mt-3 border-t border-foreground/[0.05] pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-1 text-[12.5px] text-foreground/65 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <CircleCheck
          className="h-3.5 w-3.5 text-status-healthy"
          strokeWidth={2}
          aria-hidden
        />
        {passing.length} check{passing.length === 1 ? "" : "s"} passing
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <ul className="mt-1 flex flex-col gap-1 px-1 pb-1">
          {passing.map((p) => (
            <li key={p.key} className="text-[12.5px] text-foreground/65">
              {p.headline}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── 3. Approval queue (a peek into Review) ───────────────────────────

/** How many pending changes the peek names before "See all in Review". */
const QUEUE_PEEK = 4;

function ApprovalQueueCard({ isAdmin }: { isAdmin: boolean }) {
  // `workspaceId` is OMITTED, not `null`. `null` means "pod-wide only", which
  // hid every workspace-scoped proposal — nearly the whole queue, since almost
  // every governed AI write is workspace-scoped. Omitted, the server falls to
  // `proposalUserFloor`: the viewer's own lens ∪ what they authored. Same
  // entitlement, honest count.
  const { data, isLoading, isError, refetch } = trpc.proposals.list.useQuery(
    { status: "pending", limit: QUEUE_PEEK },
    { staleTime: 30_000 }
  );
  // The count is Review's own (`signals.count`, via the nav's badge read), so
  // "See all N" always equals the number on the Review badge.
  const reviewCount = useConsoleBadges().review;

  // The row carries only `workspaceId`; `proposals.list` resolves author and
  // target names but no workspace name. The name lookup is admin-only, so a
  // member's peek reads "Workspace" instead.
  const workspaces = trpc.workspaces.adminListAll.useQuery(undefined, {
    staleTime: 60_000,
    enabled: isAdmin,
  });
  const workspaceNames = new Map(
    (workspaces.data ?? []).map((w) => [w.id, w.name] as const)
  );

  const pending = data?.items ?? [];

  return (
    <SectionCard
      title="Approval queue"
      hint="The oldest decisions waiting in Review"
      actions={
        <Button
          as={Link}
          href={navHref("review")}
          size="sm"
          variant="flat"
          radius="md"
          endContent={<ChevronRight className="h-3 w-3" />}
        >
          {reviewCount
            ? `See all ${reviewCount.text} in ${navLabel("review")}`
            : `Open ${navLabel("review")}`}
        </Button>
      }
    >
      {isLoading ? (
        <ResourceRowSkeleton count={2} />
      ) : isError || !data ? (
        <ResourceRowError
          message="Couldn't load proposals."
          onRetry={() => void refetch()}
        />
      ) : pending.length === 0 ? (
        <ResourceRowEmpty message="Nothing waiting for your review." />
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {pending.map((proposal) => {
            const workspaceLabel =
              proposal.workspaceId == null
                ? "Pod-wide"
                : (workspaceNames.get(proposal.workspaceId) ?? "Workspace");
            return (
              // Each row opens the same change inside Review — one queue,
              // with its drawer and batch rules, rather than a second one.
              <Link
                key={proposal.id}
                href={navHref("review", { focus: proposal.id })}
                className="block rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 hover:bg-content2/50"
              >
                <ResourceRow
                  Icon={Mailbox}
                  // The row has no `title` column — the old read of one fell
                  // back to a UUID slice on every row. Labelled through the
                  // ONE vocabulary door, as the search palette does.
                  primary={buildObjectActionTitle({
                    action: proposal.proposalType,
                    objectKind: proposal.targetType,
                    objectName: proposal.targetName ?? undefined,
                  })}
                  secondary={[
                    resolveObjectNoun(proposal.targetType),
                    workspaceLabel,
                    proposal.createdAt
                      ? formatRelative(proposal.createdAt)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  wrap
                />
              </Link>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

// ─── 4. Pod at a glance ───────────────────────────────────────────────

function GlanceCard() {
  return (
    <SectionCard title="Pod at a glance" hint="Sync, backups and contents">
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        <SyncRow />
        <BackupsRow />
        <ContentsRow />
      </div>
    </SectionCard>
  );
}

function GlanceError({
  Icon,
  label,
  onRetry,
}: {
  Icon: LucideIcon;
  label: string;
  onRetry: () => void;
}) {
  return (
    <ResourceRow
      Icon={Icon}
      primary={label}
      secondary="Couldn't load."
      status={{ kind: "unknown", label: "Unknown" }}
      actions={
        <Button size="sm" variant="flat" radius="md" onPress={onRetry}>
          Retry
        </Button>
      }
    />
  );
}

function SyncRow() {
  // `sync.getStatus` returns one row per peer; we summarise to a single
  // health verdict. Behind = peer with `status="error"` OR `lastError !=
  // null`. Disconnected = `enabled=false`. Healthy = all remaining peers
  // report status="idle" or "syncing".
  const { data, isLoading, isError, refetch } = trpc.sync.getStatus.useQuery(
    undefined,
    { staleTime: 60_000 }
  );

  if (isLoading) return <ResourceRowSkeleton count={1} />;
  if (isError) {
    return (
      <GlanceError
        Icon={GitBranch}
        label="Sync"
        onRetry={() => void refetch()}
      />
    );
  }

  const peers = data ?? [];
  if (peers.length === 0) {
    return (
      <ResourceRow
        Icon={GitBranch}
        primary="Sync · no peers"
        secondary="This pod is standalone."
        status={{ kind: "unknown", label: "Idle" }}
      />
    );
  }

  const errored = peers.filter(
    (p) => p.syncState?.status === "error" || p.syncState?.lastError
  );
  const disconnected = peers.filter((p) => !p.enabled);
  const lastSyncAt = peers
    .map((p) => p.syncState?.updatedAt)
    .filter((d): d is Date => d instanceof Date || typeof d === "string")
    .map((d) => (d instanceof Date ? d : new Date(d)))
    .sort((a, b) => b.getTime() - a.getTime())[0];

  let kind: StatusKind = "healthy";
  let headline = "Caught up";
  let subline = `${peers.length} peer${peers.length === 1 ? "" : "s"}`;

  if (disconnected.length > 0) {
    kind = "down";
    headline = "Disconnected";
    subline = `${disconnected.length} of ${peers.length} peers offline`;
  } else if (errored.length > 0) {
    kind = "stale";
    headline = `${errored.length} behind`;
    subline = `${errored.length} of ${peers.length} peers reporting errors`;
  }
  if (lastSyncAt) subline += ` · last sync ${formatRelative(lastSyncAt)}`;

  return (
    <ResourceRow
      Icon={GitBranch}
      primary={`Sync · ${headline}`}
      secondary={subline}
      status={{ kind, label: headline }}
    />
  );
}

function BackupsRow() {
  const { data, isLoading, isError, refetch } =
    trpc.system.getBackupStatus.useQuery(undefined, { staleTime: 60_000 });

  if (isLoading) return <ResourceRowSkeleton count={1} />;
  if (isError || !data) {
    return (
      <GlanceError
        Icon={HardDrive}
        label="Backups"
        onRetry={() => void refetch()}
      />
    );
  }

  // "ok" → healthy, "stale" → stale, "error" → down, "never" → unknown.
  const pill: Record<
    typeof data.status,
    { kind: StatusKind; label: string; headline: string }
  > = {
    ok: { kind: "healthy", label: "Healthy", headline: "Backups healthy" },
    stale: { kind: "stale", label: "Stale", headline: "Backups stale" },
    error: { kind: "down", label: "Error", headline: "Backups failing" },
    never: {
      kind: "unknown",
      label: "Never",
      headline: "No backups configured",
    },
  };
  const { kind, label, headline } = pill[data.status];

  if (data.status === "never") {
    return (
      <ResourceRow
        Icon={HardDrive}
        primary={headline}
        secondary="Configure pod backups via your hosting provider."
        status={{ kind, label }}
      />
    );
  }

  const sublineParts: string[] = [`last ${formatRelative(data.lastBackupAt)}`];
  if (data.sizeBytes != null) sublineParts.push(humanizeBytes(data.sizeBytes));
  if (data.location) sublineParts.push(truncateMiddle(data.location, 36));

  return (
    <ResourceRow
      Icon={HardDrive}
      primary={headline}
      secondary={sublineParts.join(" · ")}
      status={{ kind, label }}
    />
  );
}

function ContentsRow() {
  // Named for what it can actually answer. `system.getDataPodStats` returns
  // five row counts (users, agents, workspaces, entities, documents) and
  // nothing about bytes — no disk, no vector-index size. This was titled
  // "Capacity" and closed with a line promising disk and vector usage "once
  // the capacity procedure ships": the same defect as a disabled button
  // naming a missing procedure, in prose.
  const { data, isLoading, isError, refetch } =
    trpc.system.getDataPodStats.useQuery(undefined, { staleTime: 30_000 });

  if (isLoading) return <ResourceRowSkeleton count={1} />;
  if (isError || !data) {
    return (
      <GlanceError
        Icon={Database}
        label="Contents"
        onRetry={() => void refetch()}
      />
    );
  }

  const totalRecords = data.entityCount + data.documentCount;

  return (
    <ResourceRow
      Icon={Database}
      primary={`${totalRecords.toLocaleString()} records`}
      secondary={`${data.entityCount.toLocaleString()} entities · ${data.documentCount.toLocaleString()} documents · ${data.workspaceCount.toLocaleString()} workspaces · ${data.userCount.toLocaleString()} users`}
    />
  );
}
