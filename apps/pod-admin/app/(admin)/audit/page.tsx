"use client";

/**
 * Audit tab.
 *
 * Three sub-tabs over the same filter bar:
 *   1. Activity log    — pod-wide event log with workspace filter (live data)
 *   2. Proposals       — proposal history the viewer may review (their
 *                        workspace lens ∪ what they authored, pod-wide included)
 *   3. Approval queue  — pending proposals in that same scope + bulk actions
 *
 * The active sub-tab is encoded in `?section=` so deep links from
 * Overview's Approval queue card land in the right place.
 */

import { Suspense, useState } from "react";
import { PageHeader } from "../components/page-header";
import { UrlTabs } from "../components/url-tabs";
import { ActivitySection } from "./_lib/activity-section";
import { ApprovalQueueSection } from "./_lib/approval-queue-section";
import {
  type ActorSummary,
  type AuditFilters,
  FilterBar,
  type WorkspaceSummary,
} from "./_lib/filter-bar";
import { defaultDateRange } from "./_lib/format";
import { ProposalsSection } from "./_lib/proposals-section";

const TITLE = "Audit";
const DESCRIPTION = "What happened on this pod.";

function AuditInner() {
  // Filter state — single source for all three sub-tabs.
  const [filters, setFilters] = useState<AuditFilters>(() => ({
    ...defaultDateRange(),
    userIds: [],
    workspaceIds: [],
    actions: [],
  }));

  // Filter-options surface — populated by the Activity sub-tab once
  // `listAuditLogs` returns. Defaults are conservative.
  const [availableSubjectTypes, setAvailableSubjectTypes] = useState<string[]>([
    "workspaces",
    "workspace_members",
    "api_keys",
    "proposals",
    "agents",
    "users",
    "secrets",
    "intelligence_services",
    "trusted_issuers",
  ]);
  const [availableActors, setAvailableActors] = useState<ActorSummary[]>([]);
  const [availableWorkspaces, setAvailableWorkspaces] = useState<
    WorkspaceSummary[]
  >([]);

  function resetFilters() {
    setFilters({
      ...defaultDateRange(),
      userIds: [],
      workspaceIds: [],
      actions: [],
    });
  }

  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <PageHeader title={TITLE} description={DESCRIPTION} />

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        availableSubjectTypes={availableSubjectTypes}
        availableActors={availableActors}
        availableWorkspaces={availableWorkspaces}
        onReset={resetFilters}
      />

      <UrlTabs
        param="section"
        ariaLabel="Audit sections"
        tabs={[
          {
            key: "activity",
            label: "Activity log",
            content: (
              <ActivitySection
                filters={filters}
                onAvailableSubjectTypes={setAvailableSubjectTypes}
                onAvailableActors={setAvailableActors}
                onAvailableWorkspaces={setAvailableWorkspaces}
              />
            ),
          },
          {
            key: "proposals",
            label: "Proposals",
            content: <ProposalsSection filters={filters} />,
          },
          {
            key: "queue",
            label: "Approval queue",
            content: <ApprovalQueueSection filters={filters} />,
          },
        ]}
      />
    </div>
  );
}

export default function AuditPage() {
  return (
    <Suspense fallback={<AuditFallback />}>
      <AuditInner />
    </Suspense>
  );
}

function AuditFallback() {
  return (
    <div className="px-6 py-6 max-w-[1400px]">
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}
