"use client";

/**
 * Provenance chips — who, where and when, as one line of chips, each a door
 * to its own page when it names an object (ui-composition §3: provenance is a
 * door, not a caption).
 *
 * Extracted from the proposal review's provenance line
 * (`app/proposal/[id]/ProposalReviewCard.tsx`, lane pa-review2) so the
 * session page draws the same chips rather than a second set; that file keeps
 * its local copies until it switches to these.
 */

import type { ReactNode } from "react";
import { resolveServiceMark } from "@synap-core/types/service-marks";
import type { Exit } from "../../../lib/open-in";
import { externalProps, rowHref, usePlacedExit } from "../../../lib/exit-link";

const PILL =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-foreground/[0.04] px-2.5 text-[12.5px] text-foreground/80 ring-1 ring-inset ring-foreground/10";
const PILL_DOOR =
  "transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

/**
 * One provenance chip. With an exit it is a door to that object's own page
 * (or, on a phone that cannot follow it, the console page covering it);
 * without one — or when this device has nowhere to send it — it is a mark.
 */
export function Pill({
  exit,
  title,
  children,
}: {
  exit?: Exit;
  title?: string;
  children: ReactNode;
}) {
  if (!exit) {
    return (
      <span className={PILL} title={title}>
        {children}
      </span>
    );
  }
  return (
    <DoorPill exit={exit} title={title}>
      {children}
    </DoorPill>
  );
}

function DoorPill({
  exit,
  title,
  children,
}: {
  exit: Exit;
  title?: string;
  children: ReactNode;
}) {
  const href = rowHref(usePlacedExit(exit));
  if (href === null) {
    return (
      <span className={PILL} title={title}>
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      {...externalProps(href)}
      title={title}
      className={`${PILL} ${PILL_DOOR}`}
    >
      {children}
    </a>
  );
}

/** The agent's service mark (the registry's glyph; neutral when it has none). */
export function AgentMark({ name }: { name: string }) {
  const mark = resolveServiceMark(name, "mono");
  return (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground/80"
    >
      <svg viewBox="0 0 24 24" className="h-3 w-3" fill={mark.fill}>
        <path d={mark.path} fillRule={mark.fillRule} />
      </svg>
    </span>
  );
}

export function PersonAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-semibold text-primary"
    >
      {initials(name)}
    </span>
  );
}

/** "Antoine Servant" → "AS"; one word → its first two letters. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}
