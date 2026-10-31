"use client";

/**
 * The mark of a template update or of one field: a glyph and a tone first,
 * a few words after (ui-composition §1). The tone and glyph come from the
 * model (`fieldMark`, `groupMark`), the words from the caller, so the list,
 * the Review page, the package page and Home draw one mark per state.
 */

import {
  ArrowDownToLine,
  CircleAlert,
  Database,
  Equal,
  GitMerge,
  PenLine,
  type LucideIcon,
} from "lucide-react";
import type { Mark, MarkGlyph, MarkTone } from "./updates-model";

const GLYPHS: Readonly<Record<MarkGlyph, LucideIcon>> = {
  merge: GitMerge,
  arrive: ArrowDownToLine,
  pen: PenLine,
  equal: Equal,
  records: Database,
  alert: CircleAlert,
};

/** Ink per tone: the needs-you accent is the one ochre (primary). */
const INK: Readonly<Record<MarkTone, string>> = {
  choose: "text-primary",
  catalog: "text-status-healthy",
  consent: "text-status-stale",
  yours: "text-foreground/75",
  same: "text-foreground/60",
};

/** Fill and hairline per tone, under the same ink. */
const FILL: Readonly<Record<MarkTone, string>> = {
  choose: "bg-primary/10 ring-primary/30",
  catalog: "bg-status-healthy/10 ring-status-healthy/30",
  consent: "bg-status-stale/10 ring-status-stale/30",
  yours: "bg-foreground/[0.05] ring-foreground/15",
  same: "bg-foreground/[0.03] ring-foreground/10",
};

export function markIcon(mark: Mark): LucideIcon {
  return GLYPHS[mark.glyph];
}

export function UpdateMark({
  mark,
  label,
  plain = false,
}: {
  mark: Mark;
  label: string;
  /** Ink only, no fill: a lane's or a tab's label. */
  plain?: boolean;
}) {
  const Icon = GLYPHS[mark.glyph];
  return (
    <span
      className={[
        "inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap text-[11.5px] font-medium",
        INK[mark.tone],
        plain
          ? ""
          : `rounded-md px-1.5 py-0.5 ring-1 ring-inset ${FILL[mark.tone]}`,
      ].join(" ")}
    >
      <Icon aria-hidden className="h-3 w-3 shrink-0" strokeWidth={2.25} />
      <span className="truncate">{label}</span>
    </span>
  );
}
