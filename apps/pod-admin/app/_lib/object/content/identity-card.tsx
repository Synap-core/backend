"use client";

/**
 * An object's identity card: its kind's icon, its title and what it is, as
 * one door to its own page. What a record shows when no renderer cell draws
 * it (`RenderedObject`'s fallback): an embedded entity block
 * (`embed-view`) and a row of Home's "Made for you" both draw this one.
 */

import Link from "next/link";
import type { LucideIcon } from "lucide-react";

const DOOR =
  "underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

export function IdentityCard({
  href,
  Icon,
  title,
  noun,
}: {
  href: string;
  Icon: LucideIcon;
  title: string;
  /** What it is ("Decision"); not repeated when it is the title itself. */
  noun: string;
}) {
  return (
    <Link
      href={href}
      className={`flex max-w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] ring-1 ring-inset ring-foreground/10 hover:bg-foreground/[0.03] ${DOOR}`}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words font-medium text-foreground">
        {title}
      </span>
      {title !== noun && (
        <span className="shrink-0 text-foreground/55">· {noun}</span>
      )}
    </Link>
  );
}
