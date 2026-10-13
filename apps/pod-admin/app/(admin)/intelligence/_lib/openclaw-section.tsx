"use client";

/**
 * OpenClaw — a read-only status readout; nothing here manages it. Part of
 * `/intelligence` (`page.tsx`).
 */

import { Bot } from "lucide-react";
import { useEffect } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { SectionCard } from "../../components/section-card";
import type { StatusKind } from "../../components/status-pill";
import { StatusPill } from "../../components/status-pill";

export function OpenClawSummarySection() {
  const query = trpc.intelligenceRegistry.getOpenClawOverview.useQuery(
    undefined,
    { staleTime: 60_000, retry: false }
  );

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const oc = query.data?.openclaw;

  let status: StatusKind = "unknown";
  let statusLabel = "Not provisioned";
  if (oc?.health.status === "healthy") {
    status = "healthy";
    statusLabel = "Healthy";
  } else if (oc?.health.status === "not_responded") {
    status = "stale";
    statusLabel = "No recent traffic";
  } else if (oc?.provisioned === false) {
    status = "unknown";
    statusLabel = "Not provisioned";
  } else if (oc?.health.status === "not_configured") {
    status = "unknown";
    statusLabel = "Not configured";
  }

  return (
    <SectionCard
      title="OpenClaw"
      hint="Pod-wide agent runtime — configured outside Pod Admin"
      actions={<StatusPill kind={status} label={statusLabel} />}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-success/10"
          >
            <Bot className="h-4 w-4 text-success" strokeWidth={2} aria-hidden />
          </span>
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[14px] font-medium text-foreground">
              {query.isLoading || isAuthRedirecting
                ? "Loading…"
                : oc?.provisioned
                  ? `1 agent provisioned · ${oc.activeHubKeys} active key${
                      oc.activeHubKeys === 1 ? "" : "s"
                    }`
                  : "OpenClaw is not provisioned on this pod"}
            </span>
            <span className="text-[11.5px] text-foreground/55">
              {query.data?.lifecycleDomains?.runtime
                ? `Runtime managed by ${query.data.lifecycleDomains.runtime}`
                : "Skills and agents are configured outside Pod Admin"}
            </span>
          </div>
        </div>
        {/* This was a `href="/openclaw"` button. pod-admin serves no such
            route and there is no rewrite, so it was a hard 404 — and no
            verified OpenClaw URL exists to retarget it at. Rather than invent
            a destination, the card now simply reports what it knows. */}
      </div>
    </SectionCard>
  );
}
