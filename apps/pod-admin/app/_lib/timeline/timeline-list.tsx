"use client";

/**
 * `TimelineList` — the ONE row History and Audit draw (founder, 18 Nov 2026,
 * row density C): a mark, the line in words, who and when, grouped by day,
 * capped with "Show all". It draws entries only (`timeline-model.ts`:
 * `entryOf` / `groupEntries`); it owns no word but the day heading and the
 * folded-checks line, and no tone: the mark's tone and glyph come from
 * `markOf`, drawn through the app's one tone map (`_lib/tone`).
 *
 * The page keeps its own layout, filters, states and footer; it passes what
 * is its own through slots: `actions` (Undo), `detail` (a space name) and
 * `onSelect` (the door it opens).
 */

import { Button } from "@heroui/react";
import {
  Activity,
  AlertTriangle,
  Archive,
  Check,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleSlash,
  Clock,
  Flag,
  Gauge,
  Globe,
  Hourglass,
  Link2,
  Lock,
  Pause,
  Scale,
  Sparkles,
  User,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { formatDate, formatRelative } from "../../../lib/format";
import { useT } from "../../../lib/i18n/locale-provider";
import { viewerTimeZone } from "@synap-core/types/activity";
import type { EntryGroup, WorkEntry } from "@synap-core/types/work-view";
import { toneTextClass } from "../tone";
import { CATALOGS } from "./copy";
import { capGroups, dayGroups, rowCount } from "./timeline-model";

/** One icon per mark glyph; a glyph with no icon of its own reads as a dot. */
const GLYPH_ICON: Readonly<Record<string, LucideIcon>> = {
  person: User,
  scales: Scale,
  spark: Sparkles,
  clock: Clock,
  pause: Pause,
  link: Link2,
  check: Check,
  question: CircleHelp,
  alert: AlertTriangle,
  "dashed-circle": CircleDashed,
  lock: Lock,
  globe: Globe,
  users: Users,
  "circle-dot": CircleDot,
  x: X,
  "circle-slash": CircleSlash,
  archive: Archive,
  hourglass: Hourglass,
  gauge: Gauge,
  flag: Flag,
  triangle: AlertTriangle,
};

export function glyphIcon(glyph: string): LucideIcon {
  return GLYPH_ICON[glyph] ?? Activity;
}

export function TimelineList({
  entries,
  cap,
  expanded,
  onExpand,
  showAllLabel,
  onSelect,
  actions,
  detail,
  timeZone,
}: {
  entries: readonly WorkEntry[];
  /** Rows shown before "Show all". */
  cap: number;
  expanded: boolean;
  onExpand: () => void;
  showAllLabel: string;
  onSelect?: (entry: WorkEntry) => void;
  /** The page's own control for a row (Undo); outside the row's door. */
  actions?: (entry: WorkEntry) => ReactNode;
  /** The page's own extra words for a row (a space name). */
  detail?: (entry: WorkEntry) => string | null;
  /** Test seam; the viewer's zone otherwise. */
  timeZone?: string;
}) {
  const t = useT(CATALOGS);
  const zone = timeZone ?? viewerTimeZone();
  const all = useMemo(() => dayGroups(entries, zone), [entries, zone]);
  const total = rowCount(all);
  const shown = expanded ? all : capGroups(all, cap);
  return (
    <div>
      {shown.map((g) => (
        <section key={g.key} data-day-group={g.key}>
          <h3 className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-foreground/65">
            {dayHeading(g, t)}
          </h3>
          <ol className="divide-y divide-foreground/[0.05]">
            {g.rows.map((row) => (
              <TimelineRow
                key={row.entry.key}
                entry={row.entry}
                detail={detail?.(row.entry) ?? null}
                actions={actions?.(row.entry)}
                onSelect={onSelect}
                checksLabel={
                  row.folded.length
                    ? t("checks", { n: row.folded.length })
                    : null
                }
              />
            ))}
          </ol>
        </section>
      ))}
      {!expanded && total > cap && (
        <div className="flex justify-center pt-3">
          <Button size="sm" variant="flat" onPress={onExpand}>
            {showAllLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function dayHeading(
  g: EntryGroup,
  t: (key: "today" | "unknownDay") => string
): string {
  if (!("day" in g.label)) return "";
  if (g.label.isToday) return t("today");
  if (g.label.day === "unknown") return t("unknownDay");
  // The heading is a calendar day, read in the zone the group was made in.
  return formatDate(`${g.label.day}T12:00:00Z`);
}

function TimelineRow({
  entry,
  detail,
  actions,
  checksLabel,
  onSelect,
}: {
  entry: WorkEntry;
  detail: string | null;
  actions?: ReactNode;
  checksLabel: string | null;
  onSelect?: (entry: WorkEntry) => void;
}) {
  const Icon = glyphIcon(entry.mark.glyph);
  const secondary = [entry.who, detail, checksLabel].filter(Boolean).join(" · ");
  const body = (
    <>
      <Icon
        aria-hidden
        className={`mt-0.5 h-4 w-4 shrink-0 ${toneTextClass(entry.mark.tone)}`}
        strokeWidth={2.25}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-foreground">
          {entry.text}
        </span>
        <span className="block truncate text-[11.5px] text-foreground/65">
          {secondary}
        </span>
      </span>
      <span
        className="shrink-0 text-[11.5px] tabular text-foreground/65"
        title={entry.at}
      >
        {formatRelative(entry.at)}
      </span>
    </>
  );
  return (
    <li
      data-row-id={entry.key}
      data-mark={entry.mark.state}
      className="flex items-start gap-2 rounded-md px-3 py-2 hover:bg-content2/40"
    >
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(entry)}
          className="flex min-w-0 flex-1 items-start gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2">{body}</div>
      )}
      {actions ? <div className="shrink-0 self-center">{actions}</div> : null}
    </li>
  );
}
