"use client";

/**
 * ONE request row's three lines (`requestRow`, `@synap-core/types/needs-you`),
 * drawn with pod admin's kit — the one row Review's list, its question cards
 * and a session's "Needs you" all draw (D4: three drawings became one):
 *
 *   [kind tile]  what is asked                                  age
 *                Holds: what it holds (the thing, a door; its status move)
 *                who asked · where it came from (each a door)
 *
 * The tile is the request's FAMILY (icon = kind, its tint from the tokens:
 * a secret or connection ochre with a key, a change teal with an arrow, a
 * question neutral with a speech mark, a step to approve sage with a flag,
 * access neutral with a shield), never a chip. Every name is a door
 * (`DoorMark`); nothing here is a joined sentence.
 */

import { Fragment, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  CircleDashed,
  Clock,
  Cpu,
  Flag,
  Globe,
  HelpCircle,
  KeyRound,
  Link2,
  Lock,
  MessageSquare,
  Pause,
  Scale,
  ShieldCheck,
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

/** A request family's tile: its icon and its tint class (`globals.css` `.rq-tile-*`). */
export type RequestFamilyTile =
  "secret" | "change" | "question" | "step" | "access";

const FAMILY: Record<RequestFamilyTile, { Icon: LucideIcon; tint: string }> = {
  secret: { Icon: KeyRound, tint: "rq-tile-secret" },
  change: { Icon: ArrowUp, tint: "rq-tile-change" },
  question: { Icon: MessageSquare, tint: "rq-tile-neutral" },
  step: { Icon: Flag, tint: "rq-tile-step" },
  access: { Icon: ShieldCheck, tint: "rq-tile-neutral" },
};

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

function Tile({
  family,
  noun,
  objectKind,
}: {
  family: RequestFamilyTile;
  noun: string;
  objectKind: string;
}) {
  const { Icon, tint } = FAMILY[family];
  return (
    <span
      role="img"
      aria-label={noun}
      title={noun}
      data-kind-tile={objectKind}
      data-request-family={family}
      className={`rq-tile ${tint}`}
    >
      <Icon aria-hidden className="h-4 w-4" strokeWidth={1.75} />
    </span>
  );
}

function Part({ part }: { part: RequestRowPart }) {
  switch (part.kind) {
    case "state":
    case "tile":
    case "age":
    case "expiry":
      // Line 1 draws these itself.
      return null;
    case "text":
      return (
        <span data-row-text={part.role} className="min-w-0 break-words">
          {part.text}
        </span>
      );
    case "label":
      return <span className="shrink-0 text-foreground/55">{part.text}:</span>;
    case "door":
      return (
        <DoorMark
          door={part.door}
          className="relative z-10 inline-flex min-w-0 max-w-full items-center truncate"
        >
          <span data-row-door={part.role} className="truncate">
            {part.label}
          </span>
        </DoorMark>
      );
    case "status":
      return (
        <span className="inline-flex items-center gap-1">
          {part.now && <span>{part.now.label}</span>}
          {part.now && part.next && <span aria-hidden>→</span>}
          {part.next && <span>{part.next.label}</span>}
        </span>
      );
  }
}

export function RequestRowLines({
  family,
  what,
  holds,
  who,
  lead,
  trail,
  titleSlot,
}: {
  family: RequestFamilyTile;
  what: readonly RequestRowPart[];
  holds: readonly RequestRowPart[];
  who: readonly RequestRowPart[];
  /** Chrome before line 3's doors (the decision a row asks, outside its package). */
  lead?: ReactNode;
  /** Said after line 1 (a cluster's "and N more like it"). */
  trail?: ReactNode;
  /** Draws the title (the button that opens the decision); default: the text. */
  titleSlot?: (text: string) => ReactNode;
}) {
  const tile = what.find((p) => p.kind === "tile");
  const title = what.find((p) => p.kind === "text" && p.role === "title");
  const age = what.find((p) => p.kind === "age");
  const expiry = what.find((p) => p.kind === "expiry");
  const expiryView =
    expiry?.kind === "expiry" ? lensRowExpiry({ expiresAt: expiry.at }) : null;
  const whoParts = who.filter((p) => p.kind === "door");
  return (
    <div className="flex min-w-0 items-start gap-3">
      {tile?.kind === "tile" && (
        <Tile family={family} noun={tile.noun} objectKind={tile.objectKind} />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 break-words text-[14px] font-medium leading-5 text-foreground">
            {title?.kind === "text"
              ? titleSlot
                ? titleSlot(title.text)
                : title.text
              : null}
          </span>
          {age?.kind === "age" && (
            <span className="shrink-0 tabular-nums text-[12px] text-foreground/55">
              {formatRelative(age.at, { empty: "" })}
            </span>
          )}
        </div>
        {expiryView && (
          <span
            className={`text-[12px] ${toneTextClass(expiryView.urgent ? "warning" : "textMuted")}`}
          >
            {expiryView.label}
          </span>
        )}
        {trail}
        {holds.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] text-foreground/75">
            {holds.map((p, i) => (
              <Part key={`${p.kind}:${i}`} part={p} />
            ))}
          </div>
        )}
        {(whoParts.length > 0 || lead) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-foreground/55">
            {lead}
            {whoParts.map((p, i) => (
              <Fragment key={`${p.kind}:${i}`}>
                {(i > 0 || lead) && <span aria-hidden>·</span>}
                <Part part={p} />
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
