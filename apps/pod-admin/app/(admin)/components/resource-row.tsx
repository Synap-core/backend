"use client";

/**
 * `ResourceRow` — the canonical list-item used in every tab.
 *
 *   56px tall, padding-x 12, hover bg-content2/50
 *   [icon 16px, foreground/40] [primary] [secondary] [status pill] [⋯]
 *
 * Click anywhere on the row except the actions popover triggers `onSelect`
 * (which a parent typically uses to open a side panel). The `actions`
 * popover handles its own click-stop so it doesn't bubble.
 *
 * Skeleton, empty, and error states are sibling components so a list
 * surface can switch between them without bespoke layouts.
 */

import type { LucideIcon } from "lucide-react";
import { MoreHorizontal } from "lucide-react";
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
  /** Optional actions slot rendered as a `⋯` popover trigger. */
  actions?: ReactNode;
}

export function ResourceRow({
  Icon,
  primary,
  secondary,
  status,
  onSelect,
  actions,
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
        "group flex h-14 items-center gap-3 px-3",
        "border-b border-foreground/[0.05] last:border-b-0",
        interactive
          ? "cursor-pointer transition-colors hover:bg-content2/50"
          : "",
      ].join(" ")}
    >
      <Icon
        className="h-4 w-4 shrink-0 text-foreground/40"
        strokeWidth={2}
        aria-hidden
      />

      <div className="min-w-0 flex-1 flex flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">
          {primary}
        </span>
        {secondary && (
          <span className="truncate text-[11.5px] text-foreground/55">
            {secondary}
          </span>
        )}
      </div>

      {status && (
        <div className="shrink-0">
          <StatusPill kind={status.kind} label={status.label} />
        </div>
      )}

      {actions && (
        <div
          className="shrink-0"
          // Stop click propagation so the actions menu doesn't trigger
          // the row's onSelect.
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </div>
      )}
      {!actions && interactive && (
        <Button
          isIconOnly
          variant="light"
          size="sm"
          radius="full"
          aria-label="Row actions"
          className="text-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

// ─── Standardized states ────────────────────────────────────────────

export function ResourceRowSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex h-14 items-center gap-3 px-3 border-b border-foreground/[0.05] last:border-b-0"
        >
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
  message?: string;
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
