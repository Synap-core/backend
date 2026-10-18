"use client";

/**
 * Intelligence service instances (`intelligenceRegistry.list`). Part of
 * `/intelligence` (`page.tsx`).
 */

import { Plug } from "lucide-react";
import { useEffect } from "react";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import { SectionCard } from "../../components/section-card";
import type { StatusKind } from "../../components/status-pill";
import { ErrorBanner } from "./error-banner";

interface ISInstanceRow {
  id: string;
  serviceId: string;
  name: string;
  description?: string | null;
  status: string;
  enabled: boolean;
}

export function IntelligenceServicesSection() {
  const query = trpc.intelligenceRegistry.list.useQuery(undefined, {
    staleTime: 30_000,
  });

  useEffect(() => {
    if (query.isError) {
      redirectToLoginIfUnauthorized(query.error);
    }
  }, [query.isError, query.error]);
  const isAuthRedirecting = query.error?.data?.code === "UNAUTHORIZED";

  const rows = (query.data ?? []) as ISInstanceRow[];

  return (
    <SectionCard
      title="Intelligence service instances"
      hint="Registered IS instances that respond to /health"
      actions={
        rows.length > 0 ? (
          <span className="text-[11px] tabular text-foreground/65">
            {rows.length} instances
          </span>
        ) : null
      }
    >
      {query.isLoading || isAuthRedirecting ? (
        <ResourceRowSkeleton count={3} />
      ) : query.isError ? (
        <ErrorBanner
          message={query.error?.message ?? "Couldn't load IS registry."}
        />
      ) : rows.length === 0 ? (
        <ResourceRowEmpty message="No IS instances registered." />
      ) : (
        <div className="-mx-2 divide-y divide-foreground/[0.05]">
          {rows.map((row) => (
            <ResourceRow
              key={row.id}
              Icon={Plug}
              primary={row.name}
              secondary={[row.serviceId, row.description]
                .filter(Boolean)
                .join(" · ")}
              status={isStatusToPill(row.status, row.enabled)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function isStatusToPill(
  status: string,
  enabled: boolean
): { kind: StatusKind; label: string } {
  if (!enabled) return { kind: "unknown", label: "Disabled" };
  switch (status) {
    case "active":
      return { kind: "healthy", label: "Active" };
    case "suspended":
      return { kind: "stale", label: "Suspended" };
    case "inactive":
      return { kind: "down", label: "Inactive" };
    default:
      return { kind: "unknown", label: status };
  }
}
