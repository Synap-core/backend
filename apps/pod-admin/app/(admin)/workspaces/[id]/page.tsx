"use client";

/**
 * Space detail page — /workspaces/[id]
 *
 * 4 tabs: Overview · Members · API Keys · Connections
 * Tab state encoded in ?tab=... URL param (see UrlTabs).
 */

import { ArrowLeft } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import { trpc } from "../../../../lib/trpc";
import { StatusPill } from "../../components/status-pill";
import { UrlTabs } from "../../components/url-tabs";
import { formatRelative } from "../../../../lib/format";
import { navLabel } from "../../../../lib/console-nav";
import { openIn } from "../../../../lib/open-in";
import { ExitLink } from "../../../../lib/exit-link";
import { OverviewTab } from "./_lib/overview-tab";
import { MembersTab } from "./_lib/members-tab";
import { ApiKeysTab } from "./_lib/api-keys-tab";
import { ConnectionsTab } from "./_lib/connections-tab";
import { GovernanceTab } from "./_lib/governance-tab";
import { PageFallback, PageShell } from "../../components/page-header";

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
      label="Open in app"
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
    <Suspense fallback={<PageFallback />}>
      <WorkspaceDetailInner />
    </Suspense>
  );
}

function WorkspaceDetailInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const wsQuery = trpc.workspaces.adminGet.useQuery(
    { id },
    { staleTime: 30_000 }
  );

  const ws = wsQuery.data as Workspace | undefined;
  const status = ws ? deriveStatus(ws) : null;
  const body = (loaded: ReactNode) =>
    loaded || (wsQuery.isLoading ? <TabSkeleton /> : null);

  return (
    <PageShell>
      {/* Back button */}
      <button
        type="button"
        onClick={() => router.push("/workspaces")}
        className="mb-5 flex items-center gap-1.5 text-[12.5px] text-foreground/55 hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {navLabel("spaces")}
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
              <p className="text-[13px] text-foreground/55">Space not found.</p>
            )}
          </div>
        </div>

        {ws ? (
          <div className="flex items-center gap-2 sm:shrink-0">
            <span className="text-[11.5px] text-foreground/40">
              updated {formatRelative(ws.updatedAt)}
            </span>
            {/* This page owns the space's admin surfaces; its CONTENTS
                live in the app. That is a `synap://` link, which does
                nothing at all when the app is not installed — so the download
                fallback sits right beside it. */}
            <DesktopExit workspaceId={ws.id} />
          </div>
        ) : null}
      </header>

      {/* Tabs */}
      {wsQuery.isError ? (
        <p className="text-[12.5px] text-status-down">
          Couldn't load this space. Try again in a moment.
        </p>
      ) : (
        <UrlTabs
          param="tab"
          ariaLabel="Space sections"
          tabs={[
            {
              key: "overview",
              label: "Overview",
              content: body(ws && <OverviewTab ws={ws} />),
            },
            {
              key: "members",
              label: "Members",
              content: body(ws && <MembersTab workspaceId={ws.id} />),
            },
            {
              key: "api-keys",
              label: "API keys",
              content: body(ws && <ApiKeysTab workspaceId={ws.id} />),
            },
            {
              key: "connections",
              label: "Connections",
              content: body(ws && <ConnectionsTab workspaceId={ws.id} />),
            },
            {
              key: "governance",
              label: "Governance",
              content: body(ws && <GovernanceTab ws={ws} />),
            },
          ]}
        />
      )}
    </PageShell>
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
