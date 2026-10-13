"use client";

/**
 * `ResourceRow` — the canonical list-item used in every tab.
 *
 *   56px tall (`wrap`: at least 56px, primary line up to two lines),
 *   padding-x 12, hover bg-content2/50
 *   [icon 16px, foreground/40] [primary] [secondary] [status pill] [actions | ›]
 *
 * Click anywhere on the row except the actions slot triggers `onSelect`
 * (which a parent typically uses to open a side panel). The actions slot
 * handles its own click-stop so it doesn't bubble. A clickable row without
 * actions ends in a chevron — a cue, not a second control.
 *
 * Rows carry no border of their own: the list container draws the rules
 * with `divide-y divide-foreground/[0.05]`, so a row never needs to know
 * whether it is last.
 *
 * Skeleton, empty, and error states are sibling components so a list
 * surface can switch between them without bespoke layouts.
 */

import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { Button } from "@heroui/react";
import type { ReactNode, MouseEvent } from "react";
import type { StatusKind } from "./status-pill";
import { StatusPill } from "./status-pill";

interface ResourceRowProps {
  Icon: LucideIcon;
  primary: string;
  secondary?: string;
  /** Optional right-aligned status. Absent = healthy / no-op. */
  status?: { kind: StatusKind; label: string };
  /** Optional click handler — called when the body (not actions) is clicked. */
  onSelect?: () => void;
  /** Optional actions slot (buttons or a popover trigger) at the row's end. */
  actions?: ReactNode;
  /**
   * Let a long primary line wrap to two lines instead of truncating, and the
   * row grow to fit. Off by default so every other list keeps its fixed 56px.
   * The status pill then shows from `sm` up only: below it the headline needs
   * the width more than the pill does, and the actions drop to their own line
   * under the text so a phone row never squeezes the headline to a sliver.
   */
  wrap?: boolean;
}

export function ResourceRow({
  Icon,
  primary,
  secondary,
  status,
  onSelect,
  actions,
  wrap = false,
}: ResourceRowProps) {
  const interactive = !!onSelect;

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    // The actions slot lives inside the row but has its own click-stop —
    // anything that bubbles up here is a body click.
    e.preventDefault();
    onSelect?.();
  };

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.();
        }
      }}
      className={[
        "group flex items-center gap-3 px-3",
        wrap ? "min-h-14 flex-wrap py-2" : "h-14",
        interactive
          ? "cursor-pointer transition-colors hover:bg-content2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
          : "",
      ].join(" ")}
    >
      <Icon
        className="h-4 w-4 shrink-0 text-foreground/40"
        strokeWidth={2}
        aria-hidden
      />

      <div className="min-w-0 flex-1 flex flex-col">
        <span
          className={`${wrap ? "line-clamp-2" : "truncate"} text-[13px] font-medium text-foreground`}
        >
          {primary}
        </span>
        {secondary && (
          <span className="truncate text-[11.5px] text-foreground/55">
            {secondary}
          </span>
        )}
      </div>

      {status && (
        <div className={wrap ? "hidden shrink-0 sm:block" : "shrink-0"}>
          <StatusPill kind={status.kind} label={status.label} />
        </div>
      )}

      {actions && (
        <div
          className={
            wrap ? "shrink-0 basis-full pl-7 sm:basis-auto sm:pl-0" : "shrink-0"
          }
          // Stop click propagation so the actions menu doesn't trigger
          // the row's onSelect.
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      )}
      {!actions && interactive && (
        <ChevronRight
          className="h-4 w-4 shrink-0 text-foreground/30 transition-colors group-hover:text-foreground/55"
          aria-hidden
        />
      )}
    </div>
  );
}

// ─── Standardized states ────────────────────────────────────────────

export function ResourceRowSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col divide-y divide-foreground/[0.05]">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 px-3">
          <div className="h-4 w-4 shrink-0 rounded bg-foreground/10 shimmer-pulse" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-2.5 w-1/3 rounded bg-foreground/10 shimmer-pulse" />
            <div className="h-2 w-1/4 rounded bg-foreground/[0.07] shimmer-pulse" />
          </div>
          <div className="h-5 w-16 shrink-0 rounded bg-foreground/[0.07] shimmer-pulse" />
        </div>
      ))}
    </div>
  );
}

export function ResourceRowEmpty({
  message = "Nothing here yet.",
}: {
  message?: ReactNode;
}) {
  return (
    <p className="px-3 py-8 text-center text-[12.5px] text-foreground/55">
      {message}
    </p>
  );
}

export function ResourceRowError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-8">
      <p className="text-[12.5px] text-status-down">{message}</p>
      {onRetry && (
        <Button size="sm" variant="flat" radius="md" onPress={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
