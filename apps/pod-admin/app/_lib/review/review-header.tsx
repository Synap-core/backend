"use client";

/**
 * The card header of a REVIEW receiver page: an icon tile, the heading that
 * names what approving WILL do (imperative: "Create API key", never a type
 * token), and the status as a mark in the vocabulary's words. Shared by
 * `/proposal/[id]` and `/keys/requests/[id]`.
 */

import { CardHeader, Chip } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";

const STATUS_COLOR: Record<
  string,
  "default" | "success" | "danger" | "warning"
> = {
  pending: "warning",
  approval_failed: "warning",
  approved: "success",
  auto_approved: "success",
  rejected: "danger",
  denied: "danger",
  reverted: "default",
  withdrawn: "default",
  expired: "default",
};

export function ReviewHeader({
  icon: Icon,
  heading,
  status,
}: {
  icon: LucideIcon;
  heading: string;
  /** A status token (`pending`, `approved`, `denied`…), worded by the vocabulary. */
  status: string;
}) {
  return (
    <CardHeader className="flex items-start justify-between gap-3 px-7 pb-0 pt-7">
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20"
        >
          <Icon className="h-5 w-5" strokeWidth={2} />
        </span>
        <h1 className="min-w-0 break-words font-heading text-[22px] font-medium leading-tight tracking-tight text-foreground">
          {heading}
        </h1>
      </div>
      <Chip color={STATUS_COLOR[status] ?? "default"} variant="flat" size="sm">
        {resolveStatusLabel(status)}
      </Chip>
    </CardHeader>
  );
}
