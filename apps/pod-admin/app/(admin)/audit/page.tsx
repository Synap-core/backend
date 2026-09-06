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

import { Tabs, Tab } from "@heroui/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
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

type Section = "activity" | "proposals" | "queue";
const SECTIONS: Section[] = ["activity", "proposals", "queue"];

function AuditInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.get("section");
  const active: Section = (SECTIONS as string[]).includes(raw ?? "")
    ? (raw as Section)
    : "activity";

  function setActive(next: string | number) {
    const value = String(next);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (value === "activity") params.delete("section");
    else params.set("section", value);
    const qs = params.toString();
    router.replace(qs ? `/audit?${qs}` : "/audit", { scroll: false });
  }

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
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Audit
        </h1>
        <p className="text-[13px] text-foreground/55">
          What happened on this pod.
        </p>
      </header>

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        availableSubjectTypes={availableSubjectTypes}
        availableActors={availableActors}
        availableWorkspaces={availableWorkspaces}
        onReset={resetFilters}
      />

      <Tabs
        aria-label="Audit sections"
        variant="underlined"
        selectedKey={active}
        onSelectionChange={setActive}
        classNames={{
          tabList: "gap-4 px-0 border-b border-foreground/[0.05] rounded-none",
          tab: "px-1 h-10",
          cursor: "bg-primary",
          tabContent:
            "text-foreground/55 group-data-[selected=true]:text-foreground text-[12.5px] font-medium",
        }}
      >
        <Tab key="activity" title="Activity log">
          <div className="pt-5">
            <ActivitySection
              filters={filters}
              onAvailableSubjectTypes={setAvailableSubjectTypes}
              onAvailableActors={setAvailableActors}
              onAvailableWorkspaces={setAvailableWorkspaces}
            />
          </div>
        </Tab>
        <Tab key="proposals" title="Proposals">
          <div className="pt-5">
            <ProposalsSection filters={filters} />
          </div>
        </Tab>
        <Tab key="queue" title="Approval queue">
          <div className="pt-5">
            <ApprovalQueueSection filters={filters} />
          </div>
        </Tab>
      </Tabs>
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
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-medium tracking-tight text-foreground">
          Audit
        </h1>
        <p className="text-[13px] text-foreground/55">
          What happened on this pod.
        </p>
      </header>
      <div className="h-9 w-full max-w-md rounded-md bg-foreground/[0.05] shimmer-pulse" />
    </div>
  );
}
