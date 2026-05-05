"use client";

/**
 * `StatusPill` — single source of truth for the four-state status palette
 * used everywhere a row, card, or chip needs to convey health.
 *
 *   • healthy — green   (#34D399)
 *   • stale   — amber   (#FBBF24) — expiring soon, behind, overdue
 *   • down    — red     (#F87171) — expired, failed, disconnected
 *   • unknown — grey    (#94A3B8) — no signal yet
 *
 * Renders as a HeroUI Chip (size sm, radius sm, variant flat) so the
 * concentric radius rule (pane 24 → card 16 → inner 8) holds inside any
 * card. A leading SVG dot stays the same size (8px) regardless of label.
 *
 * Status colors are NEVER decorative. If a row is healthy, omit the pill
 * — empty space reads "all good" without adding noise.
 */

import { Chip } from "@heroui/react";

export type StatusKind = "healthy" | "stale" | "down" | "unknown";

interface StatusPillProps {
  kind: StatusKind;
  label: string;
  className?: string;
}

const palette: Record<
  StatusKind,
  { dot: string; text: string; bg: string; ring: string }
> = {
  healthy: {
    dot: "bg-status-healthy",
    text: "text-status-healthy",
    bg: "bg-status-healthy/10",
    ring: "ring-status-healthy/30",
  },
  stale: {
    dot: "bg-status-stale",
    text: "text-status-stale",
    bg: "bg-status-stale/10",
    ring: "ring-status-stale/30",
  },
  down: {
    dot: "bg-status-down",
    text: "text-status-down",
    bg: "bg-status-down/10",
    ring: "ring-status-down/30",
  },
  unknown: {
    dot: "bg-status-unknown",
    text: "text-foreground/55",
    bg: "bg-foreground/5",
    ring: "ring-foreground/10",
  },
};

export function StatusPill({ kind, label, className }: StatusPillProps) {
  const p = palette[kind];
  return (
    <Chip
      size="sm"
      radius="sm"
      variant="flat"
      className={[
        "font-medium tabular",
        p.bg,
        p.text,
        "ring-1 ring-inset",
        p.ring,
        className ?? "",
      ].join(" ")}
      startContent={
        <span
          aria-hidden
          className={[
            "ml-1 mr-1 inline-block h-1.5 w-1.5 rounded-full",
            p.dot,
          ].join(" ")}
        />
      }
    >
      {label}
    </Chip>
  );
}
