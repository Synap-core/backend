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
 * The tile is the request's FAMILY (`RequestKindTile`, also beside the
 * detail's title), never a chip. Every name is a door (`DoorMark`); nothing
 * here is a joined sentence.
 */

import { Fragment, type ReactNode } from "react";
import {
  ArrowUp,
  Flag,
  KeyRound,
  MessageSquare,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { RequestRowPart } from "@synap-core/types/needs-you";
import { lensRowExpiry } from "@synap-core/types/lens";
import { formatRelative } from "../../../lib/format";
import { toneTextClass } from "../tone";
import { DoorMark } from "./door-mark";
import type { RequestFamily } from "./family";

/** The icon carries the kind; the tile stays neutral (colour = state, UX S7). */
const FAMILY: Record<RequestFamily, LucideIcon> = {
  secret: KeyRound,
  change: ArrowUp,
  question: MessageSquare,
  step: Flag,
  access: ShieldCheck,
};

/** A request family's 28px tile, its noun as the accessible name. */
export function RequestKindTile({
  family,
  noun,
  objectKind,
}: {
  family: RequestFamily;
  noun: string;
  objectKind?: string;
}) {
  const Icon = FAMILY[family];
  return (
    <span
      role="img"
      aria-label={noun}
      title={noun}
      data-kind-tile={objectKind ?? family}
      data-request-family={family}
      className="rq-tile rq-tile-neutral"
    >
      <Icon aria-hidden className="h-4 w-4" strokeWidth={1.75} />
    </span>
  );
}

/** A part of line 2 or 3 (line 1 draws its own parts). */
function Part({ part }: { part: RequestRowPart }) {
  switch (part.kind) {
    case "text":
      return (
        <span data-row-text={part.role} className="min-w-0 break-words">
          {part.text}
        </span>
      );
    case "label":
      return <span className="shrink-0 text-foreground/70">{part.text}:</span>;
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
    default:
      return null;
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
  family: RequestFamily;
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
        <RequestKindTile
          family={family}
          noun={tile.noun}
          objectKind={tile.objectKind}
        />
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
            <span className="shrink-0 tabular-nums text-[12px] text-foreground/70">
              {formatRelative(age.at, { empty: "" })}
            </span>
          )}
        </div>
        {expiryView && (
          <span
            className={`text-[12px] ${toneTextClass(expiryView.urgent ? "warning" : "textSecondary")}`}
          >
            {expiryView.label}
          </span>
        )}
        {trail}
        {holds.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] text-foreground/80">
            {holds.map((p, i) => (
              <Part key={`${p.kind}:${i}`} part={p} />
            ))}
          </div>
        )}
        {(whoParts.length > 0 || lead) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-foreground/70">
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
