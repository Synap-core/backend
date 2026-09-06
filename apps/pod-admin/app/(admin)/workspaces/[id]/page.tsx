"use client";

/**
 * Workspace detail page — /workspaces/[id]
 *
 * 4 tabs: Overview · Members · API Keys · Connections
 * Tab state encoded in ?tab=... URL param (same pattern as trust-keys page).
 */

import { Tab, Tabs } from "@heroui/react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { trpc } from "../../../../lib/trpc";
import { StatusPill } from "../../components/status-pill";
import { formatRelative } from "../../people/_lib/helpers";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import { OverviewTab } from "./_lib/overview-tab";
import { MembersTab } from "./_lib/members-tab";
import { ApiKeysTab } from "./_lib/api-keys-tab";
import { ConnectionsTab } from "./_lib/connections-tab";
import { GovernanceTab } from "./_lib/governance-tab";

// ─── Types ────────────────────────────────────────────────────────────

type Workspace = {
  id: string;
  name: string;
  type: string;
  description: string | null;
  settings: Record<string, unknown>;
  ownerId: string;
  subscriptionTier: string | null;
  subscriptionStatus: string | null;
  memberCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
  archivedAt?: Date | string | null;
};

type WorkspaceTab =
  "overview" | "members" | "api-keys" | "connections" | "governance";
const TABS: WorkspaceTab[] = [
  "overview",
  "members",
  "api-keys",
  "connections",
  "governance",
];

/* The workspace's contents live in the desktop app. `ExitLink` carries the
   download fallback, because a `synap://` that does not resolve fails in
   total silence. */
function DesktopExit({ workspaceId }: { workspaceId: string }) {
  return (
    <ExitLink
      exit={openIn({
        kind: "object",
        objectKind: "workspace",
        id: workspaceId,
      })}
      label="Open in the desktop app"
    />
  );
}

// ─── Helpers (same as list page) ──────────────────────────────────────

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isArchived(ws: Workspace): boolean {
  if (ws.archivedAt) return true;
  const s = (ws.settings ?? {}) as Record<string, unknown>;
  return Boolean(s.archivedAt || s.archived === true);
}

function deriveStatus(ws: Workspace): {
  kind: "healthy" | "stale" | "unknown";
  label: string;
} {
  if (isArchived(ws)) return { kind: "stale", label: "Archived" };
  const updated =
    ws.updatedAt instanceof Date ? ws.updatedAt : new Date(ws.updatedAt);
  if (Date.now() - updated.getTime() < SEVEN_DAYS_MS)
    return { kind: "healthy", label: "Active" };
  return { kind: "unknown", label: "Idle" };
}

function workspaceInitial(ws: Workspace): string {
  const t = (ws.name ?? "").trim();
  return t.length > 0 ? t[0].toUpperCase() : "?";
}

function colorForWorkspace(ws: Workspace): string {
  let hash = 0;
  for (let i = 0; i < ws.id.length; i++)
    hash = (hash + ws.id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 60%, 45%)`;
}

// ─── Page shell ───────────────────────────────────────────────────────

export default function WorkspaceDetailPage() {
  return (
    <Suspense fallback={<DetailFallback />}>
      <WorkspaceDetailInner />
    </Suspense>
  );
}

function DetailFallback() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <div className="h-8 w-32 rounded-md bg-foreground/[0.05] shimmer-pulse mb-6" />
      <div className="h-10 w-1/2 rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}

function WorkspaceDetailInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();

  const raw = searchParams.get("tab");
  const activeTab: WorkspaceTab = (TABS as string[]).includes(raw ?? "")
    ? (raw as WorkspaceTab)
    : "overview";

  function setTab(next: string | number) {
    const value = String(next);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (value === "overview") params.delete("tab");
    else params.set("tab", value);
    const qs = params.toString();
    router.replace(qs ? `/workspaces/${id}?${qs}` : `/workspaces/${id}`, {
      scroll: false,
    });
  }

  const wsQuery = trpc.workspaces.adminGet.useQuery(
    { id },
    { staleTime: 30_000 }
  );

  const ws = wsQuery.data as Workspace | undefined;
  const status = ws ? deriveStatus(ws) : null;

  return (
    <div className="px-6 py-6 max-w-[1400px]">
      {/* Back button */}
      <button
        type="button"
        onClick={() => router.push("/workspaces")}
        className="mb-5 flex items-center gap-1.5 text-[12.5px] text-foreground/55 hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Workspaces
      </button>

      {/* Header */}
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          {ws ? (
            <span
              aria-hidden
              className="glass-icon flex h-10 w-10 shrink-0 items-center justify-center text-[15px] font-semibold text-white"
              style={{ background: colorForWorkspace(ws) }}
            >
              {workspaceInitial(ws)}
            </span>
          ) : (
            <div className="h-10 w-10 shrink-0 rounded-xl bg-foreground/[0.08] shimmer-pulse" />
          )}
          <div className="flex flex-col gap-0.5 min-w-0">
            {ws ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground leading-tight">
                    {ws.name}
                  </h1>
                  {status ? (
                    <StatusPill kind={status.kind} label={status.label} />
                  ) : null}
                </div>
                <p className="font-mono text-[11.5px] text-foreground/40">
                  {ws.id}
                </p>
              </>
            ) : wsQuery.isLoading ? (
              <>
                <div className="h-7 w-48 rounded bg-foreground/[0.08] shimmer-pulse" />
                <div className="h-3.5 w-72 rounded bg-foreground/[0.05] shimmer-pulse mt-1" />
              </>
            ) : (
              <p className="text-[13px] text-foreground/55">
                Workspace not found.
              </p>
            )}
          </div>
        </div>

        {ws ? (
          <div className="flex items-center gap-2 sm:shrink-0">
            <span className="text-[11.5px] text-foreground/40">
              updated {formatRelative(new Date(ws.updatedAt))}
            </span>
            {/* This page owns the workspace's admin surfaces; its CONTENTS
                live in the desktop app. That is a `synap://` link, which does
                nothing at all when the app is not installed — so the download
                fallback sits right beside it. */}
            <DesktopExit workspaceId={ws.id} />
          </div>
        ) : null}
      </header>

      {/* Tabs */}
      {wsQuery.isError ? (
        <p className="text-[12.5px] text-status-down">
          Could not load workspace: {wsQuery.error.message}
        </p>
      ) : (
        <Tabs
          aria-label="Workspace sections"
          variant="underlined"
          selectedKey={activeTab}
          onSelectionChange={setTab}
          classNames={{
            tabList:
              "gap-4 px-0 border-b border-foreground/[0.05] rounded-none",
            tab: "px-1 h-10",
            cursor: "bg-primary",
            tabContent:
              "text-foreground/55 group-data-[selected=true]:text-foreground text-[12.5px] font-medium",
          }}
        >
          <Tab key="overview" title="Overview">
            <div className="pt-5">
              {ws ? (
                <OverviewTab ws={ws} />
              ) : wsQuery.isLoading ? (
                <TabSkeleton />
              ) : null}
            </div>
          </Tab>
          <Tab key="members" title="Members">
            <div className="pt-5">
              {ws ? (
                <MembersTab workspaceId={ws.id} />
              ) : wsQuery.isLoading ? (
                <TabSkeleton />
              ) : null}
            </div>
          </Tab>
          <Tab key="api-keys" title="API keys">
            <div className="pt-5">
              {ws ? (
                <ApiKeysTab workspaceId={ws.id} />
              ) : wsQuery.isLoading ? (
                <TabSkeleton />
              ) : null}
            </div>
          </Tab>
          <Tab key="connections" title="Connections">
            <div className="pt-5">
              {ws ? (
                <ConnectionsTab workspaceId={ws.id} />
              ) : wsQuery.isLoading ? (
                <TabSkeleton />
              ) : null}
            </div>
          </Tab>
          <Tab key="governance" title="Governance">
            <div className="pt-5">
              {ws ? (
                <GovernanceTab ws={ws} />
              ) : wsQuery.isLoading ? (
                <TabSkeleton />
              ) : null}
            </div>
          </Tab>
        </Tabs>
      )}
    </div>
  );
}

function TabSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-14 rounded-lg bg-foreground/[0.04] ring-1 ring-inset ring-foreground/10 shimmer-pulse"
        />
      ))}
    </div>
  );
}
