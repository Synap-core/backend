"use client";

/**
 * Audit log — what happened on this pod: the pod-wide event log under one
 * filter bar.
 *
 * Decisions moved to Review (`/review`): pending proposals are its Changes
 * and Access, decided ones its History. The old `?section=proposals` /
 * `?section=queue` links redirect there.
 */

import { Suspense, useState } from "react";
import { PageHeader } from "../components/page-header";
import { ActivitySection } from "./_lib/activity-section";
import {
  type ActorSummary,
  type AuditFilters,
  FilterBar,
  type WorkspaceSummary,
} from "./_lib/filter-bar";
import { defaultDateRange } from "./_lib/format";

const TITLE = "Audit log";
const DESCRIPTION = "What happened on this pod.";

function AuditInner() {
  const [filters, setFilters] = useState<AuditFilters>(() => ({
    ...defaultDateRange(),
    userIds: [],
    workspaceIds: [],
    actions: [],
  }));

  // Filter-options surface — populated by the activity log once
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

      <ActivitySection
        filters={filters}
        onAvailableSubjectTypes={setAvailableSubjectTypes}
        onAvailableActors={setAvailableActors}
        onAvailableWorkspaces={setAvailableWorkspaces}
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
