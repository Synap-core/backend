"use client";

/**
 * ONE request row's three lines (`requestRow`, `@synap-core/types/needs-you`),
 * drawn with pod admin's kit — the one row Review's list, its question cards
 * and a session's "Needs you" all draw (D4: three drawings became one):
 *
 *   1  state mark · kind tile · what is asked · age (· expiry)
 *   2  what it holds: the thing (a door) and the status it cannot reach yet,
 *      else what answering unblocks, else the reason
 *   3  who asked (a door) · where it came from (a door)
 *
 * State is a MARK (tone + glyph, its word for screen readers and on hover),
 * the kind a tile, every name a door (`DoorMark`). Nothing here is a joined
 * sentence.
 */

import type { ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Clock,
  Cpu,
  Globe,
  HelpCircle,
  Link2,
  Lock,
  Pause,
  Scale,
  Sparkles,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { RequestRowPart } from "@synap-core/types/needs-you";
import { resolveUnitState, type UnitGlyph } from "@synap-core/types/units";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { lensRowExpiry } from "@synap-core/types/lens";
import { formatRelative } from "../../../lib/format";
import { kindIcon } from "../object/kind-icon";
import { toneMarkClass, toneTextClass } from "../tone";
import { DoorMark } from "./door-mark";

/** The shared glyph token → this kit's icon (drawing only; the token is decided once). */
const GLYPH: Record<UnitGlyph, LucideIcon> = {
  person: User,
  scales: Scale,
  spark: Sparkles,
  clock: Clock,
  pause: Pause,
  link: Link2,
  check: Check,
  question: HelpCircle,
  alert: AlertTriangle,
  "dashed-circle": CircleDashed,
  lock: Lock,
  globe: Globe,
  users: Users,
  cpu: Cpu,
};

export function glyphIcon(glyph: UnitGlyph): LucideIcon {
  return GLYPH[glyph];
}

/** A state as one mark: its tone and glyph, its word as the accessible name. */
export function StateMark({
  state,
}: {
  state: Extract<RequestRowPart, { kind: "state" }>["state"];
}) {
  const view = resolveUnitState(state);
  const Icon = GLYPH[view.glyph];
  const label = resolveStatusLabel(view.state);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-state-mark={view.state}
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ${toneMarkClass(view.tone)}`}
    >
      <Icon aria-hidden className="h-3 w-3" strokeWidth={2} />
    </span>
  );
}

function Part({ part, title }: { part: RequestRowPart; title?: ReactNode }) {
  switch (part.kind) {
    case "state":
      return <StateMark state={part.state} />;
    case "tile": {
      const Icon = kindIcon(part.objectKind);
      return (
        <span
          role="img"
          aria-label={part.noun}
          title={part.noun}
          data-kind-tile={part.objectKind}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05] text-foreground/65"
        >
          <Icon aria-hidden className="h-3 w-3" strokeWidth={1.75} />
        </span>
      );
    }
    case "text":
      if (part.role === "title")
        return (
          <span className="min-w-0 flex-1 break-words text-[13px] font-medium leading-5 text-foreground">
            {title ?? part.text}
          </span>
        );
      return (
        <span
          data-row-text={part.role}
          className="min-w-0 break-words text-foreground/75"
        >
          {part.text}
        </span>
      );
    case "label":
      return (
        <span className="shrink-0 font-medium text-foreground/55">
          {part.text}
        </span>
      );
    case "door":
      return (
        <DoorMark
          door={part.door}
          className={`inline-flex min-w-0 max-w-full items-center gap-1 truncate ${
            part.role === "thing" ? "text-foreground/85" : "text-foreground/70"
          }`}
        >
          <span data-row-door={part.role} className="truncate">
            {part.label}
          </span>
        </DoorMark>
      );
    case "status":
      return (
        <span className="inline-flex items-center gap-1 text-foreground/65">
          {part.now && <span>{part.now.label}</span>}
          {part.now && part.next && <span aria-hidden>→</span>}
          {part.next && (
            <span className="text-foreground/85">{part.next.label}</span>
          )}
        </span>
      );
    case "age":
      return (
        <span className="shrink-0 tabular-nums text-[12px] text-foreground/55">
          {formatRelative(part.at, { empty: "" })}
        </span>
      );
    case "expiry": {
      const expiry = lensRowExpiry({ expiresAt: part.at });
      if (!expiry) return null;
      return (
        <span
          className={`shrink-0 text-[12px] ${toneTextClass(expiry.urgent ? "warning" : "textMuted")}`}
        >
          {expiry.label}
        </span>
      );
    }
  }
}

function Line({
  parts,
  className,
}: {
  parts: readonly RequestRowPart[];
  className: string;
}) {
  if (parts.length === 0) return null;
  return (
    <div className={className}>
      {parts.map((p, i) => (
        <Part key={`${p.kind}:${i}`} part={p} />
      ))}
    </div>
  );
}

export function RequestRowLines({
  what,
  holds,
  who,
  lead,
  trail,
  titleSlot,
}: {
  what: readonly RequestRowPart[];
  holds: readonly RequestRowPart[];
  who: readonly RequestRowPart[];
  /** Chrome before line 3's doors (the decision a row asks, outside its package). */
  lead?: ReactNode;
  /** Said after line 1's title (a cluster's "and N more like it"). */
  trail?: ReactNode;
  /** Draws the title (a button that opens the decision); default: the text. */
  titleSlot?: (text: string) => ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-start gap-2">
        {what.map((p, i) =>
          p.kind === "text" && p.role === "title" ? (
            <Part
              key={`title:${i}`}
              part={p}
              title={titleSlot ? titleSlot(p.text) : undefined}
            />
          ) : (
            <span key={`${p.kind}:${i}`} className="mt-0 flex shrink-0">
              <Part part={p} />
            </span>
          )
        )}
      </div>
      {trail}
      <Line
        parts={holds}
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-12 text-[12px]"
      />
      {(who.length > 0 || lead) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pl-12 text-[12px] text-foreground/65">
          {lead}
          {who.map((p, i) => (
            <Part key={`${p.kind}:${i}`} part={p} />
          ))}
        </div>
      )}
    </div>
  );
}
