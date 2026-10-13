"use client";

/**
 * Review › History — the proposals already decided that this viewer may
 * review (`proposals.list`, the viewer's own floor), newest first. Opening
 * one shows the same decision card with its outcome.
 */

import { useEffect } from "react";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { trpc } from "../../../../lib/trpc";
import { redirectToLoginIfUnauthorized } from "../../../../lib/auth-redirect";
import { formatRelative } from "../../../../lib/format";
import {
  ResourceRow,
  ResourceRowEmpty,
  ResourceRowError,
  ResourceRowSkeleton,
} from "../../components/resource-row";
import type { StatusKind } from "../../components/status-pill";
import { kindIcon, kindLabel } from "../../../_lib/object/kind-icon";
import { proposalHeading } from "../../../proposal/[id]/proposal-heading";

/** Status → pill colour only; the word comes from the vocabulary. */
const STATUS_KIND: Record<string, StatusKind> = {
  approved: "healthy",
  auto_approved: "healthy",
  rejected: "down",
  approval_failed: "stale",
};

export function ReviewHistory({
  onOpen,
}: {
  onOpen: (proposalId: string, title: string) => void;
}) {
  const list = trpc.proposals.list.useQuery(
    { status: "all", limit: 100 },
    { staleTime: 30_000 }
  );
  useEffect(() => {
    if (list.isError) redirectToLoginIfUnauthorized(list.error);
  }, [list.isError, list.error]);

  if (list.isLoading) return <ResourceRowSkeleton count={4} />;
  if (list.isError)
    return (
      <ResourceRowError
        message="Couldn't load decided proposals."
        onRetry={() => void list.refetch()}
      />
    );
  const decided = (list.data?.items ?? []).filter(
    (p) => p.status !== "pending"
  );
  if (decided.length === 0)
    return <ResourceRowEmpty message="Nothing decided yet." />;

  return (
    <>
      {decided.map((p) => {
        const { heading } = proposalHeading(p, p.request?.data ?? p.data);
        const named = p as { appName?: string; workspaceName?: string };
        const who = named.appName ?? p.authorName;
        return (
          <div key={p.id} data-row-id={p.id}>
            <ResourceRow
              Icon={kindIcon(p.targetType)}
              primary={heading}
              secondary={[
                kindLabel(p.targetType),
                who,
                named.workspaceName,
                formatRelative(p.reviewedAt ?? p.updatedAt),
              ]
                .filter(Boolean)
                .join(" · ")}
              status={{
                kind: STATUS_KIND[p.status] ?? "unknown",
                label: resolveStatusLabel(p.status),
              }}
              wrap
              onSelect={() => onOpen(p.id, heading)}
            />
          </div>
        );
      })}
    </>
  );
}
