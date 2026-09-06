"use client";

/**
 * `HandoffCard` — what pod-admin renders where it deliberately stops.
 *
 * pod-admin is the pod's front desk. Plenty of things it can NAME it cannot
 * OWN: connector re-auth, the secrets vault, per-kind package installs, the
 * intelligence service config. Before 2026-09-05 those places rendered the
 * full frame — a section, a row, a button — with the button permanently
 * `isDisabled` behind a tooltip naming the tRPC procedure nobody had written
 * ("Pending: connectors.reauthenticate"). Five surfaces did this.
 *
 * A disabled button teaches "this app is broken". A handoff teaches "this
 * lives over there" — which is true, useful, and the whole product story of a
 * pod that is one surface among several.
 *
 * So: never render a dead control. Render this instead, and say plainly where
 * the capability actually lives.
 *
 * `exit` comes from `openIn()` — the one door. When it resolves to a
 * `synap://` link the fallback is rendered automatically, because a desktop
 * link that does not resolve fails silently and would strand the reader.
 */

import { Button } from "@heroui/react";
import { ArrowUpRight, type LucideIcon } from "lucide-react";
import type { Exit } from "../../../lib/open-in";
import { ExitFallback } from "../../../lib/exit-link";

interface HandoffCardProps {
  /** What lives elsewhere, phrased as a statement of fact. */
  title: string;
  /** Why it lives there, and what the reader will find. One or two sentences. */
  body: string;
  /** The resolved destination. */
  exit: Exit;
  /** Imperative label for the primary action, e.g. "Open Connectors settings". */
  cta: string;
  icon?: LucideIcon;
}

export function HandoffCard({
  title,
  body,
  exit,
  cta,
  icon: Icon,
}: HandoffCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-content2/40 px-4 py-4 ring-1 ring-inset ring-foreground/[0.06]">
      <div className="flex items-start gap-3">
        {Icon && (
          <Icon
            className="mt-0.5 h-4 w-4 shrink-0 text-foreground/65"
            strokeWidth={2}
            aria-hidden
          />
        )}
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[13px] font-medium text-foreground">{title}</p>
          <p className="text-[12.5px] leading-relaxed text-foreground/65">
            {body}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-0 sm:pl-7">
        {/* radius="sm" (8px) matches the card's `rounded-lg`: a child more
            rounded than its parent is the most common reason a surface reads
            as slightly off. `min-h-10` because this is the primary door out of
            a dead end, and `size="sm"` alone gives a 32px target. */}
        <Button
          as="a"
          href={exit.href}
          {...(/^https?:/.test(exit.href)
            ? { target: "_blank", rel: "noopener noreferrer" }
            : {})}
          size="sm"
          radius="sm"
          variant="flat"
          className="min-h-10"
          endContent={<ArrowUpRight className="h-3.5 w-3.5" />}
        >
          {cta}
        </Button>

        {/* A `synap://` href does nothing at all when the app isn't installed —
            the browser shows no error. This is the way out of that silence. */}
        <ExitFallback exit={exit} />
      </div>
    </div>
  );
}
